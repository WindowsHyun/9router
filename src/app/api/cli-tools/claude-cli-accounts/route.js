import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { DATA_DIR } from "@/lib/dataDir";
import {
  getProviderConnections,
  createProviderConnection,
  updateProviderConnection,
} from "@/models";
import { resolveClaudeBin } from "open-sse/executors/claude-cli.js";

export const dynamic = "force-dynamic";

const PROVIDER = "claude-cli";
// Claude Code keeps its credentials per config directory, so one directory is
// one account. Giving each connection its own is what makes several accounts
// usable at once — see CLAUDE_CONFIG_DIR in open-sse/config/claudeCli.js.
const ACCOUNTS_DIR = path.join(DATA_DIR, "claude-cli-accounts");
const CREDENTIALS_FILE = ".credentials.json";

/** Claude Code writes this once a login completes. */
async function isSignedIn(configDir) {
  if (!configDir) return false;
  try {
    const stat = await fs.stat(path.join(configDir, CREDENTIALS_FILE));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** The account the host itself is signed into, used when no connection exists. */
function hostConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude");
}

/**
 * Whether an account can authenticate, by the only two means there are.
 *
 * A token account carries its own credential in CLAUDE_CODE_OAUTH_TOKEN, so
 * there is no directory to inspect — having the token IS being signed in.
 * Only a config-directory account has a credentials file to look for.
 *
 * This lives in one place because it did not: "Check" re-derived it from the
 * file alone, so it declared every token account signed out and deactivated
 * it, while the listing showed the same account as signed in.
 */
async function accountSignedIn(psd = {}) {
  if (psd.oauthToken) return true;
  return isSignedIn(psd.configDir || "");
}

async function describe(connection) {
  const psd = connection.providerSpecificData || {};
  const configDir = psd.configDir || "";
  const signedIn = await accountSignedIn(psd);
  return {
    id: connection.id,
    name: connection.name || connection.displayName || "Claude Code account",
    email: connection.email || "",
    configDir,
    kind: psd.oauthToken ? "token" : (psd.kind || "isolated"),
    signedIn,
    isActive: connection.isActive !== false,
    testStatus: connection.testStatus,
    createdAt: connection.createdAt,
  };
}

/**
 * Open an interactive Claude Code session so the user can run /login.
 *
 * This is the one place a console is required: Claude Code's sign-in is an
 * interactive TUI flow, so there is nothing to collect from a fetch. The
 * routed request path never does this — it spawns the binary directly with no
 * shell (see executors/claude-cli.js).
 *
 * The directory is server-generated, never caller-supplied, so nothing the
 * user types reaches the command line.
 */
function launchLoginWindow(bin, configDir) {
  if (process.platform === "win32") {
    // `start` is a cmd builtin, so cmd is unavoidable here. The title argument
    // ("") must come first or start treats the quoted path as the title.
    const child = spawn(
      "cmd",
      ["/c", "start", "", "cmd", "/k", `set "CLAUDE_CONFIG_DIR=${configDir}" && "${bin}"`],
      { detached: true, stdio: "ignore", windowsHide: false },
    );
    child.unref();
    return { launched: true, how: "A terminal window opened. Run /login there, then come back and press Check." };
  }

  const terminals = [
    ["x-terminal-emulator", ["-e", bin]],
    ["gnome-terminal", ["--", bin]],
    ["konsole", ["-e", bin]],
    ["open", ["-a", "Terminal", bin]],
  ];
  for (const [cmd, args] of terminals) {
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      });
      child.unref();
      return { launched: true, how: "A terminal window opened. Run /login there, then come back and press Check." };
    } catch {
      // try the next one
    }
  }
  return {
    launched: false,
    how: `No terminal could be opened. Run this yourself:\n  CLAUDE_CONFIG_DIR="${configDir}" ${bin}\nthen /login.`,
  };
}

// GET /api/cli-tools/claude-cli-accounts — accounts and their sign-in state
export async function GET() {
  try {
    const bin = resolveClaudeBin();
    const connections = await getProviderConnections({ provider: PROVIDER });
    const accounts = await Promise.all(connections.map(describe));

    // With no accounts configured the provider falls back to whatever the host
    // is signed into, so report that too rather than claiming nothing works.
    const hostDir = hostConfigDir();
    return NextResponse.json({
      installed: !!bin,
      bin: bin || "",
      accounts,
      connectedCount: accounts.filter((a) => a.signedIn && a.isActive).length,
      host: { configDir: hostDir, signedIn: await isSignedIn(hostDir) },
    });
  } catch (error) {
    console.log("Error listing claude-cli accounts:", error);
    return NextResponse.json({ error: "Failed to list accounts" }, { status: 500 });
  }
}

// POST — add an account and open its login window, or re-open an existing one
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));

    // Token account: the only way to attach an account where no interactive
    // login is possible, which is the normal case in a container. Generated
    // with `claude setup-token` on any machine that can run the TUI.
    if (typeof body.oauthToken === "string" && body.oauthToken.trim()) {
      const token = body.oauthToken.trim();
      const existing = await getProviderConnections({ provider: PROVIDER });
      if (existing.some((c) => c.providerSpecificData?.oauthToken === token)) {
        return NextResponse.json({ error: "That token is already added." }, { status: 409 });
      }
      const created = await createProviderConnection({
        provider: PROVIDER,
        authType: "none",
        accessToken: "cli",
        name: body.name || `Token account ${existing.length + 1}`,
        displayName: body.name || `Token account ${existing.length + 1}`,
        providerSpecificData: { oauthToken: token, kind: "token" },
        testStatus: "active",
        isActive: true,
      });
      return NextResponse.json({ account: await describe(created) }, { status: 201 });
    }

    const bin = resolveClaudeBin();
    if (!bin) {
      return NextResponse.json(
        {
          error: "Claude Code is not installed here. Install it, set CLI_CLAUDE_BIN, "
            + "or add an account with a token from `claude setup-token`.",
        },
        { status: 400 },
      );
    }

    // Re-open the login window for an account that exists already.
    if (body.id) {
      // getProviderConnections filters by provider and isActive only.
      const match = (await getProviderConnections({ provider: PROVIDER })).find((c) => c.id === body.id);
      if (!match) return NextResponse.json({ error: "Account not found" }, { status: 404 });
      const configDir = match.providerSpecificData?.configDir;
      if (!configDir) return NextResponse.json({ error: "That account has no config directory" }, { status: 400 });
      await fs.mkdir(configDir, { recursive: true });
      return NextResponse.json({ ...launchLoginWindow(bin, configDir), id: match.id, configDir });
    }

    // Adopt the account the host is already signed into, rather than making
    // the user log in again for the first one.
    if (body.adoptHost === true) {
      const hostDir = hostConfigDir();
      if (!(await isSignedIn(hostDir))) {
        return NextResponse.json({ error: "This machine is not signed in to Claude Code yet." }, { status: 400 });
      }
      const existing = await getProviderConnections({ provider: PROVIDER });
      if (existing.some((c) => c.providerSpecificData?.configDir === hostDir)) {
        return NextResponse.json({ error: "This machine's account is already added." }, { status: 409 });
      }
      const created = await createProviderConnection({
        provider: PROVIDER,
        authType: "none",
        accessToken: "cli",
        name: body.name || "This machine",
        displayName: body.name || "This machine",
        providerSpecificData: { configDir: hostDir, kind: "host" },
        testStatus: "active",
        isActive: true,
      });
      return NextResponse.json({ account: await describe(created) }, { status: 201 });
    }

    const configDir = path.join(ACCOUNTS_DIR, randomUUID());
    await fs.mkdir(configDir, { recursive: true });

    const created = await createProviderConnection({
      provider: PROVIDER,
      authType: "none",
      accessToken: "cli",
      name: body.name || "Claude Code account",
      displayName: body.name || "Claude Code account",
      providerSpecificData: { configDir, kind: "isolated" },
      // Not usable until the login completes; the routed path skips inactive
      // connections, so an unfinished login cannot swallow traffic.
      testStatus: "pending",
      isActive: false,
    });

    return NextResponse.json(
      { account: await describe(created), ...launchLoginWindow(bin, configDir) },
      { status: 201 },
    );
  } catch (error) {
    console.log("Error adding claude-cli account:", error);
    return NextResponse.json({ error: error.message || "Failed to add account" }, { status: 500 });
  }
}

// PATCH — re-check sign-in state and activate an account once it has logged in
export async function PATCH(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const connections = await getProviderConnections({ provider: PROVIDER });
    const target = connections.find((c) => c.id === body.id);
    if (!target) return NextResponse.json({ error: "Account not found" }, { status: 404 });

    const signedIn = await accountSignedIn(target.providerSpecificData);

    await updateProviderConnection(target.id, {
      isActive: signedIn,
      testStatus: signedIn ? "active" : "pending",
      existingProviderSpecificData: target.providerSpecificData,
    });

    const [refreshed] = (await getProviderConnections({ provider: PROVIDER })).filter((c) => c.id === target.id);
    return NextResponse.json({ account: await describe(refreshed || target), signedIn });
  } catch (error) {
    console.log("Error checking claude-cli account:", error);
    return NextResponse.json({ error: "Failed to check account" }, { status: 500 });
  }
}
