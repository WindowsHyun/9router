"use server";

import { NextResponse } from "next/server";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import { resolveClaudeBin } from "open-sse/executors/claude-cli.js";
import { CLAUDE_CLI_NESTED_ENV_KEYS } from "open-sse/config/claudeCli.js";

const execAsync = promisify(exec);
// execFile takes an argv array, so a path containing quotes or shell operators
// cannot become a command — `bin` comes from operator config, not a request.
const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 10000;

// Mirror the executor's env scrub so the probe behaves like a routed request.
function probeEnv() {
  const env = { ...process.env };
  for (const key of CLAUDE_CLI_NESTED_ENV_KEYS) delete env[key];
  return env;
}

async function readVersion(bin) {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], {
      windowsHide: true,
      timeout: VERSION_TIMEOUT_MS,
      env: probeEnv(),
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Status for the Claude Code CLI provider (`claude -p`).
 * Reports the exact binary the executor would spawn, so the dashboard and the
 * runtime can never disagree about which install is in play.
 */
export async function GET() {
  const bin = resolveClaudeBin();
  const pinned = !!process.env.CLI_CLAUDE_BIN?.trim();

  let source = null;
  try {
    await fs.access(bin);
    source = pinned ? "env" : "filesystem";
  } catch {
    // Not an absolute hit — it may still resolve through PATH.
    try {
      const lookup = process.platform === "win32" ? "where" : "which";
      await execFileAsync(lookup, ["claude"], { windowsHide: true, timeout: VERSION_TIMEOUT_MS });
      source = "path";
    } catch {
      source = null;
    }
  }

  if (!source) {
    return NextResponse.json({
      installed: false,
      bin,
      version: null,
      source: null,
      hint: "Install Claude Code (https://claude.com/claude-code) and sign in once, or set CLI_CLAUDE_BIN to the binary path.",
    });
  }

  const version = await readVersion(bin);
  return NextResponse.json({
    installed: true,
    bin,
    source,
    version,
    // A version probe never touches the account, so this cannot confirm login;
    // the first routed request surfaces an auth problem as a stream error.
    authHint: version ? null : "Binary found but `claude --version` failed — check the install.",
  });
}
