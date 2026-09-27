/**
 * Routed usage, end to end, with a real request.
 *
 *   node scripts/fork/check-routed-usage-live.mjs
 *
 * The quota tracker's figures for claude-cli are counted from what this server
 * routed. Every earlier check proved a piece of that — the API shape, the
 * parser, the card — and the numbers were still reported as not showing up.
 * None of them ever put a request through and then looked at the figure.
 *
 * This does: adopt the host's Claude Code login as an account, send one real
 * `/v1/chat/completions` through it, then read /api/usage/<id> back and require
 * the routed counters to be non-zero and to carry tokens.
 *
 * It therefore spends one small Claude request on whatever account this machine
 * is logged into. It skips instead of failing when `claude` is missing or not
 * signed in, so it stays runnable on a machine that cannot do that.
 *
 * Needs port 21999 free.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = process.env.ROUTER_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 21999;
const PASSWORD = "routed-usage-live-password";
const DATA_DIR = path.join(os.tmpdir(), `9r-routed-usage-${Date.now()}`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

const call = (opts, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, timeout: 300000, ...opts }, (res) => {
    let data = "";
    res.on("data", (c) => { data += c; });
    res.on("end", () => {
      let json = null;
      try { json = JSON.parse(data); } catch { /* sse or html */ }
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
        NODE_OPTIONS: `--require "${path.join(ROOT, "custom-server.js").replace(/\\/g, "/")}"`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });

  await waitFor(async () => (await call({ method: "GET", path: "/api/health" })).status < 500,
    240000, "next dev to answer");

  const login = await call({ method: "POST", path: "/api/auth/login", headers: { "content-type": "application/json" } },
    JSON.stringify({ password: PASSWORD }));
  const m = /auth_token=([^;]+)/.exec([].concat(login.headers["set-cookie"] || []).join("; "));
  if (!m) throw new Error("no session cookie from login");
  const cookie = `auth_token=${m[1]}`;
  const json = { cookie, "content-type": "application/json" };

  // Needs a real, signed-in Claude Code on this machine — a fabricated token
  // would fail the request and prove nothing about the counters.
  const accounts = await call({ method: "GET", path: "/api/cli-tools/claude-cli-accounts", headers: { cookie } });
  if (!accounts.json?.installed || !accounts.json?.host?.signedIn) {
    console.log("  SKIP  routed usage (needs Claude Code installed and signed in on this machine)");
    process.exit(0);
  }

  const adopted = await call({ method: "POST", path: "/api/cli-tools/claude-cli-accounts", headers: json },
    JSON.stringify({ adoptHost: true }));
  const id = adopted.json?.account?.id;
  check("the host's Claude Code account can be adopted", Boolean(id),
    `status=${adopted.status} body=${adopted.body.slice(0, 200)}`);
  if (!id) throw new Error("cannot continue without an account");

  // Before: nothing routed yet, so every window must read zero rather than
  // being absent — an absent figure is what "no quota shows up" looks like.
  const before = await call({ method: "GET", path: `/api/usage/${encodeURIComponent(id)}`, headers: { cookie } });
  const beforeQuotas = before.json?.quotas || {};
  check("usage reports routed windows before any traffic",
    Object.keys(beforeQuotas).length >= 2,
    `quotas=${JSON.stringify(Object.keys(beforeQuotas))}`);
  check("...and they start at zero",
    beforeQuotas["routed 24h · requests"]?.used === 0,
    `requests=${JSON.stringify(beforeQuotas["routed 24h · requests"])}`);

  // /v1/* authenticates with an API key, not the dashboard session.
  const keyRes = await call({ method: "POST", path: "/api/keys", headers: json },
    JSON.stringify({ name: "routed-usage-live-check" }));
  const apiKey = keyRes.json?.apiKey?.key || keyRes.json?.key || keyRes.json?.apiKey;
  check("an API key can be minted for the routed request",
    typeof apiKey === "string" && apiKey.length > 0,
    `status=${keyRes.status} body=${keyRes.body.slice(0, 200)}`);

  // One real routed request through the CLI.
  const completion = await call({
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  }, JSON.stringify({
    model: "claude-cli/claude-cli-haiku",
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    stream: false,
  }));
  check("a real request routes through the Claude Code CLI",
    completion.status === 200 && Boolean(completion.json?.choices?.length),
    `status=${completion.status} body=${completion.body.slice(0, 300)}`);

  // Usage is written after the response completes, so give it a moment.
  let afterQuotas = {};
  try {
    await waitFor(async () => {
      const after = await call({ method: "GET", path: `/api/usage/${encodeURIComponent(id)}?force=1`, headers: { cookie } });
      afterQuotas = after.json?.quotas || {};
      return (afterQuotas["routed 24h · requests"]?.used || 0) > 0;
    }, 30000, "the routed request counter to move");
  } catch { /* asserted below */ }

  check("the routed request counter moves after that request",
    (afterQuotas["routed 24h · requests"]?.used || 0) >= 1,
    `after=${JSON.stringify(afterQuotas["routed 24h · requests"])}`);
  check("...and tokens are counted, not just the request",
    (afterQuotas["routed 24h · tokens"]?.used || 0) > 0,
    `tokens=${JSON.stringify(afterQuotas["routed 24h · tokens"])}`);
  check("the 5h window sees it too",
    (afterQuotas["routed 5h · requests"]?.used || 0) >= 1,
    `5h=${JSON.stringify(afterQuotas["routed 5h · requests"])}`);
  check("every figure is still flagged unlimited, with no invented reset",
    Object.values(afterQuotas).every((q) => q.unlimited === true && q.resetAt === null),
    JSON.stringify(afterQuotas).slice(0, 200));
} catch (e) {
  check("harness completed", false, e.message);
} finally {
  if (server) server.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

const pass = results.filter((r) => r.ok).length;
if (pass !== results.length) console.log(`\n--- server log tail ---\n${log.slice(-3000)}`);
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
