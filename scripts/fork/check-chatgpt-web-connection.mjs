/**
 * The ChatGPT Web bridge session, end to end, against a real Next server.
 *
 *   node scripts/fork/check-chatgpt-web-connection.mjs
 *
 * Exists because of a bug nothing here could have caught: the bridge holds the
 * chatgpt.com session itself and the executor reaches it through
 * CHATGPT_WEB_BASE_URL, so routing never needed a connection row — and none was
 * ever created. Everything that *counts* accounts reads providerConnections,
 * so a signed-in, working bridge reported "No connections" forever.
 *
 * A real bridge needs Chromium, a display and a live chatgpt.com session, none
 * of which exist in CI or on a dev box. So this stands a stub bridge on
 * loopback that answers /session the way the real one does, points 9Router at
 * it, and drives the whole path: paste a session, watch the row appear, watch
 * it reach the Providers payload and the quota tracker, then forget it and
 * watch the row go.
 *
 * What it does NOT prove: that the real bridge accepts a real session. That
 * needs the real thing. It proves everything on this side of the HTTP call.
 *
 * Uses `next dev` with a scratch DATA_DIR that is removed at the end.
 * Takes a few minutes and needs ports 21996 and 21997 free.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = process.env.ROUTER_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 21996;
const BRIDGE_PORT = 21997;
const PASSWORD = "chatgpt-web-connection-test-password";
const DATA_DIR = path.join(os.tmpdir(), `9r-cgw-${Date.now()}`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

// ── the stub bridge ───────────────────────────────────────────────────────
// Mirrors the real agent's contract: GET returns current state, POST verifies
// a pasted session and returns capabilities, DELETE forgets it.
const bridgeState = { signedIn: false, capabilities: {}, received: null };
const bridge = http.createServer((req, res) => {
  const send = (body) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET") {
    return send({
      signedIn: bridgeState.signedIn,
      capabilities: bridgeState.capabilities,
      verifiedAt: bridgeState.signedIn ? new Date().toISOString() : null,
    });
  }
  if (req.method === "DELETE") {
    bridgeState.signedIn = false;
    bridgeState.capabilities = {};
    return send({ signedIn: false });
  }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    try { bridgeState.received = JSON.parse(body); } catch { bridgeState.received = null; }
    bridgeState.signedIn = true;
    bridgeState.capabilities = { plan: "Plus", models: ["light", "medium", "high"] };
    send({
      signedIn: true,
      capabilities: bridgeState.capabilities,
      verifiedAt: new Date().toISOString(),
    });
  });
});

const call = (opts, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, timeout: 180000, ...opts }, (res) => {
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

const rowsOf = (payload) => (payload?.connections || []).filter((c) => c.provider === "chatgpt-web");

let server;
let log = "";
try {
  await new Promise((r) => bridge.listen(BRIDGE_PORT, "127.0.0.1", r));
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
        // The session endpoint derives its host from the bridge base URL and
        // its port from this, so both point at the stub.
        CHATGPT_WEB_BASE_URL: `http://127.0.0.1:${BRIDGE_PORT}`,
        CHATGPT_WEB_SESSION_PORT: String(BRIDGE_PORT),
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
  check("dashboard login issues a session", Boolean(m), `status=${login.status}`);
  const cookie = m ? `auth_token=${m[1]}` : null;
  if (!cookie) throw new Error("cannot continue without a session");
  const json = { cookie, "content-type": "application/json" };

  // ── before: the exact symptom ──────────────────────────────────────────
  const before = await call({ method: "GET", path: "/api/providers", headers: { cookie } });
  check("no chatgpt-web row exists before signing in", rowsOf(before.json).length === 0,
    `rows=${rowsOf(before.json).length}`);

  // ── sign in through the dashboard route ────────────────────────────────
  // A fabricated cookie value: the stub bridge is what would reject a real bad
  // one, and no real session should ever appear in a test.
  const session = "__Secure-next-auth.session-token=eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..fake.fixture.value";
  const connect = await call({ method: "POST", path: "/api/cli-tools/chatgpt-web-session", headers: json },
    JSON.stringify({ session }));
  check("the session is accepted and the bridge verifies it",
    connect.status === 200 && connect.json?.signedIn === true,
    `status=${connect.status} body=${connect.body.slice(0, 200)}`);
  check("the pasted session reached the bridge, not the database",
    Boolean(bridgeState.received) && JSON.stringify(bridgeState.received).includes("fake.fixture.value"),
    "the bridge should receive the cookies it has to store");

  // ── the fix: it is now counted ─────────────────────────────────────────
  const after = await call({ method: "GET", path: "/api/providers", headers: { cookie } });
  const row = rowsOf(after.json)[0];
  check("a connection row now exists for the bridge", Boolean(row),
    `body=${after.body.slice(0, 300)}`);
  check("...stored as authType none, which the grid counts",
    row?.authType === "none", `authType=${row?.authType}`);
  check("...and active, so the card reads Connected rather than No connections",
    row?.testStatus === "active" && row?.isActive !== false,
    `testStatus=${row?.testStatus} isActive=${row?.isActive}`);
  // The row must not pin a baseUrl, or it would override the environment and
  // freeze the bridge address into the database.
  check("...carrying no baseUrl, so the bridge address still comes from env",
    row?.providerSpecificData?.baseUrl === undefined,
    `baseUrl=${row?.providerSpecificData?.baseUrl}`);

  // ── it reaches the quota tracker too ───────────────────────────────────
  const eligible = await call({
    method: "GET",
    path: "/api/providers/client?page=1&pageSize=100&accountStatus=all&sort=priority",
    headers: { cookie },
  });
  check("the quota tracker counts it as eligible",
    rowsOf(eligible.json).length >= 1,
    `rows=${rowsOf(eligible.json).length} options=${JSON.stringify(eligible.json?.providerOptions)}`);
  check("...and offers chatgpt-web in its provider filter",
    (eligible.json?.providerOptions || []).includes("chatgpt-web"),
    `options=${JSON.stringify(eligible.json?.providerOptions)}`);

  const usage = await call({ method: "GET", path: `/api/usage/${encodeURIComponent(row?.id)}`, headers: { cookie } });
  const quotas = usage.json?.quotas || {};
  check("usage returns routed figures for it", Object.keys(quotas).length > 0,
    `status=${usage.status} body=${usage.body.slice(0, 200)}`);
  // The bridge reports no quota, so nothing here may look like a limit.
  check("every figure is flagged unlimited, with no reset invented",
    Object.values(quotas).every((q) => q.unlimited === true && q.resetAt === null),
    `quotas=${JSON.stringify(quotas).slice(0, 200)}`);
  check("...and the payload says the numbers are 9Router's own",
    /9Router/.test(usage.json?.message || "") && usage.json?.source === "9router",
    `message=${usage.json?.message}`);

  // ── a bridge that drops out must not delete the account ────────────────
  bridgeState.signedIn = false;
  await call({ method: "GET", path: "/api/cli-tools/chatgpt-web-session", headers: { cookie } });
  const afterSignout = await call({ method: "GET", path: "/api/providers", headers: { cookie } });
  const stale = rowsOf(afterSignout.json)[0];
  check("a signed-out bridge marks the row expired instead of deleting it",
    Boolean(stale) && stale.testStatus === "expired",
    `row=${JSON.stringify(stale)?.slice(0, 200)}`);

  // ── signing back in heals it ───────────────────────────────────────────
  await call({ method: "POST", path: "/api/cli-tools/chatgpt-web-session", headers: json },
    JSON.stringify({ session }));
  const healed = rowsOf((await call({ method: "GET", path: "/api/providers", headers: { cookie } })).json)[0];
  check("signing in again makes it active, without a second row",
    healed?.testStatus === "active" && rowsOf((await call({ method: "GET", path: "/api/providers", headers: { cookie } })).json).length === 1,
    `testStatus=${healed?.testStatus}`);

  // ── forgetting the session is deliberate, so the row goes ──────────────
  await call({ method: "DELETE", path: "/api/cli-tools/chatgpt-web-session", headers: { cookie } });
  const afterForget = await call({ method: "GET", path: "/api/providers", headers: { cookie } });
  check("forgetting the session removes the row", rowsOf(afterForget.json).length === 0,
    `rows=${rowsOf(afterForget.json).length}`);
} catch (e) {
  check("harness completed", false, e.message);
} finally {
  if (server) server.kill();
  bridge.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

const pass = results.filter((r) => r.ok).length;
if (pass !== results.length) console.log(`\n--- server log tail ---\n${log.slice(-2500)}`);
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
