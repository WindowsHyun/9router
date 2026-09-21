/**
 * End-to-end check of the ChatGPT Web sign-in console, against a real Next
 * server.
 *
 *   node scripts/fork/check-bridge-console.mjs
 *
 * The unit tests (tests/unit/chatgpt-web-vnc-proxy.test.js) wire a server by
 * hand. This drives the whole path instead: boots Next, logs in through the
 * real dashboard endpoint, fetches the console, opens its WebSocket, and
 * follows the exact URL the dashboard hands the card.
 *
 * It runs `next dev`, not a production build — deliberately. The wrapper is
 * loaded with NODE_OPTIONS=--require, which is inherited by the server process
 * Next forks, and a dev server registers its **own** `upgrade` listener for
 * HMR. That makes it the harder case for the property that matters: Node
 * dispatches an upgrade to every listener, so the console's socket must be
 * claimed in the emit override or Next's handler ends it. A live competing
 * listener is exactly what this needs.
 *
 * It also covers what a hand-wired test cannot: the jwt-secret *file* path. No
 * JWT_SECRET is set, so the proxy has to find the secret the app generated in
 * DATA_DIR — a scratch directory, removed at the end.
 *
 * Note: booting `next dev` makes Next re-add its agent-rules block to
 * CLAUDE.md. That is expected and not this script's doing — `git checkout --
 * CLAUDE.md` afterwards, or upgrade-fork.mjs will refuse the dirty tree.
 *
 * Takes a few minutes, needs ports 21993 and 46081 free, and touches no real
 * 9Router state. Exits non-zero on the first thing that does not hold.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT = process.env.ROUTER_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PASSWORD = "console-dev-test-password";
const BRIDGE_PORT = 46081;
const PORT = 21993;
const PREFIX = "/api/cli-tools/chatgpt-web-vnc";
const DATA_DIR = path.join(os.tmpdir(), `9r-dev-console-${Date.now()}`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

// ── stand-in for websockify ───────────────────────────────────────────────
const seen = [];
const bridge = http.createServer((req, res) => {
  seen.push({ kind: "http", headers: { ...req.headers }, url: req.url });
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<html>noVNC stub ${req.url}</html>`);
});
bridge.on("upgrade", (req, socket) => {
  seen.push({ kind: "ws", headers: { ...req.headers }, url: req.url });
  const accept = crypto.createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on("data", (c) => socket.write(c));
});

const call = (opts, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, timeout: 120000, ...opts }, (res) => {
    let data = "";
    res.on("data", (c) => { data += c; });
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
  });
  r.on("error", reject);
  r.on("timeout", () => { r.destroy(new Error("request timeout")); });
  if (body) r.write(body);
  r.end();
});

function upgrade(urlPath, cookie, holdMs = 0) {
  return new Promise((resolve, reject) => {
    let status = 0;
    let closedEarly = false;
    let echoed = null;
    let settled = false;
    let body = Buffer.alloc(0);
    const done = () => { if (!settled) { settled = true; resolve({ status, closedEarly, echoed }); } };
    const s = net.connect(PORT, "127.0.0.1", () => {
      s.write(`GET ${urlPath} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n`
        + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n`
        + "Sec-WebSocket-Version: 13\r\n"
        + (cookie ? `Cookie: ${cookie}\r\n` : "") + "\r\n");
    });
    let buf = Buffer.alloc(0);
    s.on("data", (c) => {
      if (!status) {
        buf = Buffer.concat([buf, c]);
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        status = Number(buf.slice(0, end).toString().split(" ")[1]);
        if (status !== 101) { s.destroy(); done(); return; }
        body = buf.slice(end + 4);
        s.write(Buffer.from("ping-dev-server"));
        if (!holdMs) setTimeout(done_if_echoed, 3000);
        return;
      }
      body = Buffer.concat([body, c]);
      if (echoed === null && body.length >= 15) {
        echoed = body.slice(0, 15).toString();
        if (!holdMs) { s.destroy(); done(); }
      }
    });
    function done_if_echoed() { s.destroy(); done(); }
    s.on("close", () => { closedEarly = true; done(); });
    s.on("error", reject);
    if (holdMs) setTimeout(() => { s.destroy(); done(); }, holdMs);
  });
}

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
  await new Promise((r) => bridge.listen(BRIDGE_PORT, "127.0.0.1", r));

  const env = { ...process.env };
  delete env.JWT_SECRET;
  // Next's binary directly, not npx.cmd: spawning a .cmd without a shell is
  // EINVAL on Windows, and a shell here would only add a layer that could
  // swallow NODE_OPTIONS.
  server = spawn(process.execPath,
    [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "--webpack", "--port", String(PORT)], {
      cwd: ROOT,
      env: {
        ...env,
        DATA_DIR,
        INITIAL_PASSWORD: PASSWORD,
        CHATGPT_WEB_BASE_URL: "http://127.0.0.1:17841",
        CHATGPT_WEB_VNC_PORT: String(BRIDGE_PORT),
        // Inherited by the server process Next forks — this is what makes the
        // wrapper (and therefore the proxy) load into a dev server at all.
        // NODE_OPTIONS is parsed shell-style: it splits on spaces (this repo
        // path has one) and treats backslashes as escapes. So: quoted, and
        // forward slashes, which Windows accepts anyway.
        NODE_OPTIONS: `--require "${path.join(ROOT, "custom-server.js").replace(/\\/g, "/")}"`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });

  await waitFor(async () => (await call({ method: "GET", path: "/api/health" })).status < 500,
    180000, "next dev to answer");
  check("wrapper loaded into the real Next server", log.includes("[bridge-vnc] proxying"),
    log.includes("[bridge-vnc]") ? log.split("\n").find((l) => l.includes("[bridge-vnc]")) : "no [bridge-vnc] line in server output");

  const anon = await call({ method: "GET", path: `${PREFIX}/vnc.html` });
  check("console refuses anonymous HTTP", anon.status === 403, `status=${anon.status} body=${anon.body.slice(0, 80)}`);

  const anonWs = await upgrade(`${PREFIX}/websockify`, null);
  check("console refuses anonymous websocket", anonWs.status !== 101, `status=${anonWs.status}`);

  const login = await call({ method: "POST", path: "/api/auth/login", headers: { "content-type": "application/json" } },
    JSON.stringify({ password: PASSWORD }));
  const cookieHeader = [].concat(login.headers["set-cookie"] || []).join("; ");
  const m = /auth_token=([^;]+)/.exec(cookieHeader);
  check("real dashboard login issues a session", Boolean(m), `status=${login.status} body=${login.body.slice(0, 150)}`);
  const cookie = m ? `auth_token=${m[1]}` : null;

  if (cookie) {
    const page = await call({ method: "GET", path: `${PREFIX}/vnc.html`, headers: { cookie } });
    check("console served (jwt secret read from DATA_DIR, not env)",
      page.status === 200 && page.body.includes("noVNC stub /vnc.html"),
      `status=${page.status} body=${page.body.slice(0, 150)}`);

    const lastHttp = seen.filter((s) => s.kind === "http").pop();
    check("bridge got no dashboard cookie over HTTP",
      Boolean(lastHttp) && lastHttp.headers.cookie === undefined,
      lastHttp ? `cookie=${lastHttp.headers.cookie}` : "bridge saw no request");

    const ws = await upgrade(`${PREFIX}/websockify`, cookie, 10000);
    check("console websocket reaches 101 past Next's live HMR listener", ws.status === 101, `status=${ws.status}`);
    check("bytes round-trip through the real server", ws.echoed === "ping-dev-server", `echoed=${ws.echoed}`);
    check("socket survives 10s on the real server", ws.closedEarly === false, `closedEarly=${ws.closedEarly}`);

    const wsSeen = seen.filter((s) => s.kind === "ws").pop();
    check("bridge got no dashboard cookie on the socket",
      Boolean(wsSeen) && wsSeen.headers.cookie === undefined,
      wsSeen ? `cookie=${wsSeen.headers.cookie}` : "bridge saw no upgrade");

    const status = await call({ method: "GET", path: "/api/cli-tools/chatgpt-web-settings", headers: { cookie } });
    let parsed = {};
    try { parsed = JSON.parse(status.body); } catch { /* keep raw */ }
    check("the card is handed a console URL to open",
      typeof parsed.vncUrl === "string" && parsed.vncUrl.startsWith(PREFIX),
      `status=${status.status} vncUrl=${parsed.vncUrl} body=${status.body.slice(0, 200)}`);
    check("that URL is not 403 for a signed-in operator",
      parsed.vncUrl ? (await call({ method: "GET", path: parsed.vncUrl, headers: { cookie } })).status === 200 : false,
      "followed the exact URL the dashboard would open");
  }
} catch (e) {
  check("harness completed", false, e.message);
} finally {
  if (server) server.kill();
  bridge.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

const pass = results.filter((r) => r.ok).length;
if (pass !== results.length) console.log(`\n--- server log tail ---\n${log.slice(-3000)}`);
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
