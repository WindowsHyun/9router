/**
 * The Claude Code accounts route, against a real Next server.
 *
 *   node scripts/fork/check-claude-accounts.mjs
 *
 * Exists because of a bug that unit tests could not have caught: the account
 * listing and the "Check" button each decided signed-in state for themselves,
 * and only the listing knew that a token account carries its own credential.
 * Check looked for a credentials *file*, never found one, reported the account
 * signed out and wrote isActive:false — switching off the only kind of account
 * that works in a container, and telling its owner to go and finish /login in
 * a terminal that does not exist.
 *
 * So this drives the real route: add a token account, list it, press Check,
 * and assert the account is still signed in and still active afterwards.
 *
 * Uses `next dev` (no production build needed) with the wrapper loaded through
 * NODE_OPTIONS, and a scratch DATA_DIR that is removed at the end — it never
 * touches real 9Router state.
 *
 * Note: booting `next dev` makes Next re-add its agent-rules block to
 * CLAUDE.md. That is expected and not this script's doing — `git checkout --
 * CLAUDE.md` afterwards, or upgrade-fork.mjs will refuse the dirty tree.
 *
 * Takes a few minutes and needs port 21995 free.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = process.env.ROUTER_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 21995;
const PASSWORD = "claude-accounts-test-password";
const ROUTE = "/api/cli-tools/claude-cli-accounts";
const DATA_DIR = path.join(os.tmpdir(), `9r-claude-accounts-${Date.now()}`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

const call = (opts, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, timeout: 120000, ...opts }, (res) => {
    let data = "";
    res.on("data", (c) => { data += c; });
    res.on("end", () => {
      let json = null;
      try { json = JSON.parse(data); } catch { /* keep raw */ }
      resolve({ status: res.statusCode, headers: res.headers, body: data, json });
    });
  });
  r.on("error", reject);
  r.on("timeout", () => r.destroy(new Error("request timeout")));
  if (body) r.write(body);
  r.end();
});

const waitFor = async (fn, ms, label) => {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${label} (${last})`);
};

let server;
let log = "";
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const env = { ...process.env };
  delete env.JWT_SECRET;
  server = spawn(process.execPath,
    [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "--webpack", "--port", String(PORT)], {
      cwd: ROOT,
      env: {
        ...env,
        DATA_DIR,
        INITIAL_PASSWORD: PASSWORD,
        // NODE_OPTIONS is parsed shell-style: quote a spaced path, and use
        // forward slashes because backslashes read as escapes.
        NODE_OPTIONS: `--require "${path.join(ROOT, "custom-server.js").replace(/\\/g, "/")}"`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });

  await waitFor(async () => (await call({ method: "GET", path: "/api/health" })).status < 500,
    180000, "next dev to answer");

  const login = await call({ method: "POST", path: "/api/auth/login", headers: { "content-type": "application/json" } },
    JSON.stringify({ password: PASSWORD }));
  const m = /auth_token=([^;]+)/.exec([].concat(login.headers["set-cookie"] || []).join("; "));
  check("dashboard login issues a session", Boolean(m), `status=${login.status}`);
  const cookie = m ? `auth_token=${m[1]}` : null;
  if (!cookie) throw new Error("cannot continue without a session");
  const json = { cookie, "content-type": "application/json" };

  // A setup token is an opaque string to this route; it is not validated
  // against the API here, which is what makes this testable offline.
  const token = `sk-ant-oat01-test-${Date.now()}`;
  const added = await call({ method: "POST", path: ROUTE, headers: json },
    JSON.stringify({ oauthToken: token }));
  check("a token account can be added", added.status === 201 && Boolean(added.json?.account?.id),
    `status=${added.status} body=${added.body.slice(0, 200)}`);
  const id = added.json?.account?.id;

  const listed = await call({ method: "GET", path: ROUTE, headers: { cookie } });
  const account = listed.json?.accounts?.find((a) => a.id === id);
  check("it is listed as a token account, signed in", account?.kind === "token" && account?.signedIn === true,
    `kind=${account?.kind} signedIn=${account?.signedIn}`);
  check("the card would show it connected", (listed.json?.connectedCount ?? 0) >= 1,
    `connectedCount=${listed.json?.connectedCount}`);

  // The regression. Before the fix this returned signedIn:false and wrote
  // isActive:false, because it looked for a credentials file a token account
  // does not have.
  const checked = await call({ method: "PATCH", path: ROUTE, headers: json }, JSON.stringify({ id }));
  check("Check reports a token account as signed in", checked.json?.signedIn === true,
    `signedIn=${checked.json?.signedIn} body=${checked.body.slice(0, 200)}`);
  check("Check leaves it active rather than switching it off",
    checked.json?.account?.isActive === true,
    `isActive=${checked.json?.account?.isActive}`);

  const after = await call({ method: "GET", path: ROUTE, headers: { cookie } });
  const stillThere = after.json?.accounts?.find((a) => a.id === id);
  check("it survives Check as an active, signed-in account",
    stillThere?.signedIn === true && stillThere?.isActive === true,
    `signedIn=${stillThere?.signedIn} isActive=${stillThere?.isActive}`);
  check("and is still counted as connected", (after.json?.connectedCount ?? 0) >= 1,
    `connectedCount=${after.json?.connectedCount}`);

  // Multi-account is the point of this route existing.
  const second = await call({ method: "POST", path: ROUTE, headers: json },
    JSON.stringify({ oauthToken: `${token}-b` }));
  const both = await call({ method: "GET", path: ROUTE, headers: { cookie } });
  check("a second token account can be added", second.status === 201, `status=${second.status}`);
  check("both are counted", (both.json?.connectedCount ?? 0) >= 2,
    `connectedCount=${both.json?.connectedCount}`);

  const dup = await call({ method: "POST", path: ROUTE, headers: json }, JSON.stringify({ oauthToken: token }));
  check("the same token twice is refused", dup.status === 409, `status=${dup.status}`);

  // Removal is not on this route — the card deletes the underlying connection.
  await call({ method: "DELETE", path: `/api/providers/${encodeURIComponent(id)}`, headers: { cookie } });
} catch (e) {
  check("harness completed", false, e.message);
} finally {
  if (server) server.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

const pass = results.filter((r) => r.ok).length;
if (pass !== results.length) console.log(`\n--- server log tail ---\n${log.slice(-2500)}`);
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
