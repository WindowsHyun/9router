/**
 * The ChatGPT Web sign-in console proxy.
 *
 * Signing in to chatgpt.com needs a real browser window, and that window
 * belongs to the bridge's launcher on its virtual display. The dashboard used
 * to call the `open` npm package server-side, which opens a browser on the
 * machine running Node — nothing at all in a container. So the router proxies
 * the bridge's noVNC console on its own origin instead.
 *
 * These tests cover the two things that can go quietly wrong: the console
 * being reachable without a dashboard session, and the wiring in
 * custom-server.js being dropped (the require is deliberately fail-soft, so a
 * missing piece does not crash the server — it just makes Login do nothing,
 * which is the bug this replaced).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

import {
  CHATGPT_WEB_VNC_PREFIX,
  assertBridgeBaseUrl,
  chatGptWebVncUrl,
  isChatGptWebVncProxyEnabled,
} from "open-sse/config/chatgptWeb.js";

// Anchored to the repo root, not the CWD: vitest runs from tests/, and a bare
// relative path silently resolved to tests/src once already.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require_ = createRequire(import.meta.url);
const proxyModule = require_(path.join(REPO_ROOT, "bridge-vnc-proxy.cjs"));
const { createBridgeVncProxy, isPrivateHost, resolveTarget, upstreamPath, forwardableHeaders } = proxyModule;

const SECRET = "vnc-proxy-test-secret";
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function mintToken({ secret = SECRET, alg = "HS256", authenticated = true, exp, nbf } = {}) {
  const header = b64url(JSON.stringify({ alg, typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    authenticated,
    iat: Math.floor(Date.now() / 1000),
    exp: exp ?? Math.floor(Date.now() / 1000) + 3600,
    ...(nbf ? { nbf } : {}),
  }));
  const signature = alg === "none"
    ? ""
    : b64url(crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

describe("bridge console target resolution", () => {
  it("is disabled when no bridge is configured, so a desktop install proxies nothing", () => {
    expect(resolveTarget({})).toBeNull();
    expect(isChatGptWebVncProxyEnabled({})).toBe(false);
    expect(chatGptWebVncUrl({})).toBeNull();
    expect(createBridgeVncProxy({})).toBeNull();
  });

  it("derives the console from the same variable routed traffic uses", () => {
    expect(resolveTarget({ CHATGPT_WEB_BASE_URL: "http://chatgpt-web:17841" }))
      .toEqual({ host: "chatgpt-web", port: 6080, tls: false });
    expect(resolveTarget({ CHATGPT_WEB_BASE_URL: "http://127.0.0.1:17841" }))
      .toEqual({ host: "127.0.0.1", port: 6080, tls: false });
  });

  it("honours an explicit console URL and port override", () => {
    expect(resolveTarget({ CHATGPT_WEB_VNC_URL: "http://10.1.2.3:7000" }))
      .toEqual({ host: "10.1.2.3", port: 7000, tls: false });
    expect(resolveTarget({ CHATGPT_WEB_BASE_URL: "http://127.0.0.1:17841", CHATGPT_WEB_VNC_PORT: "6081" }))
      .toEqual({ host: "127.0.0.1", port: 6081, tls: false });
  });

  it("refuses a public host, so the session cannot be proxied off the network", () => {
    expect(resolveTarget({ CHATGPT_WEB_BASE_URL: "http://evil.example.com:17841" })).toBeNull();
    // 169.254.169.254 is the cloud metadata service.
    expect(resolveTarget({ CHATGPT_WEB_BASE_URL: "http://169.254.169.254:17841" })).toBeNull();
    expect(resolveTarget({ CHATGPT_WEB_BASE_URL: "not a url" })).toBeNull();
    expect(resolveTarget({ CHATGPT_WEB_VNC_PORT: "6080" })).toBeNull();
  });

  /**
   * bridge-vnc-proxy.cjs cannot import open-sse/config/chatgptWeb.js: it is
   * ESM, and the proxy has to run inside the CJS server wrapper. Its host
   * check is therefore a copy, and this is what keeps the copy honest.
   */
  it("agrees with the ESM bridge-URL validator on which hosts are private", () => {
    const hosts = [
      "127.0.0.1", "localhost", "::1", "chatgpt-web", "bridge.local", "svc.internal",
      "10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.10", "100.64.0.1",
      "fd00::1", "fc00::1",
      "evil.example.com", "8.8.8.8", "169.254.169.254", "172.15.0.1", "172.32.0.1",
      "192.169.1.1", "100.128.0.1", "fe80::1", "999.1.1.1",
    ];
    for (const host of hosts) {
      const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      let esmAccepts = true;
      try {
        assertBridgeBaseUrl(`http://${bracketed}:17841`);
      } catch {
        esmAccepts = false;
      }
      expect(isPrivateHost(host), `disagreement on ${host}`).toBe(esmAccepts);
    }
  });
});

describe("console URL handed to the dashboard", () => {
  it("passes noVNC a socket path with no leading slash", () => {
    // noVNC 1.3.0 (Debian bookworm) builds the socket URL as
    // `ws://<origin>` + '/' + path — app/ui.js. A leading slash would dial
    // //api/... and miss the proxy entirely.
    const url = chatGptWebVncUrl({ CHATGPT_WEB_BASE_URL: "http://chatgpt-web:17841" });
    expect(url.startsWith(`${CHATGPT_WEB_VNC_PREFIX}/vnc.html?`)).toBe(true);
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("path")).toBe(`${CHATGPT_WEB_VNC_PREFIX.replace(/^\//, "")}/websockify`);
    expect(params.get("path").startsWith("/")).toBe(false);
    expect(params.get("autoconnect")).toBe("true");
  });

  it("keeps the prefix in step with the proxy that serves it", () => {
    expect(proxyModule.PREFIX).toBe(CHATGPT_WEB_VNC_PREFIX);
  });
});

describe("request shaping", () => {
  it("refuses a path that escapes the prefix", () => {
    expect(upstreamPath(`${CHATGPT_WEB_VNC_PREFIX}/../../etc/passwd`)).toBeNull();
    expect(upstreamPath(`${CHATGPT_WEB_VNC_PREFIX}/vnc.html`)).toBe("/vnc.html");
    expect(upstreamPath(CHATGPT_WEB_VNC_PREFIX)).toBe("/");
  });

  it("never forwards the dashboard session or the peer stamp to the bridge", () => {
    const out = forwardableHeaders({
      cookie: "auth_token=secret",
      authorization: "Bearer x",
      "x-9r-peer-token": "p",
      "x-9r-real-ip": "1.2.3.4",
      host: "router:20128",
      connection: "keep-alive",
      "user-agent": "probe",
    });
    expect(out.cookie).toBeUndefined();
    expect(out.authorization).toBeUndefined();
    expect(out["x-9r-peer-token"]).toBeUndefined();
    expect(out["x-9r-real-ip"]).toBeUndefined();
    expect(out.host).toBeUndefined();
    expect(out.connection).toBeUndefined();
    expect(out["user-agent"]).toBe("probe");
  });
});

describe("serving the console", () => {
  let bridge;
  let router;
  let routerPort;
  let seen;

  beforeAll(async () => {
    seen = [];
    // Stands in for websockify: one static file, and a 101 followed by a raw
    // byte echo. Echoing bytes rather than real frames proves both directions
    // of the pipe without reimplementing WebSocket framing.
    bridge = http.createServer((req, res) => {
      seen.push({ kind: "http", url: req.url, headers: { ...req.headers } });
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html>noVNC stub ${req.url}</html>`);
    });
    bridge.on("upgrade", (req, socket) => {
      seen.push({ kind: "ws", url: req.url, headers: { ...req.headers } });
      const accept = crypto.createHash("sha1")
        .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on("data", (chunk) => socket.write(chunk));
    });
    await new Promise((r) => bridge.listen(0, "127.0.0.1", r));

    const proxy = createBridgeVncProxy({
      JWT_SECRET: SECRET,
      CHATGPT_WEB_BASE_URL: "http://127.0.0.1:17841",
      CHATGPT_WEB_VNC_PORT: String(bridge.address().port),
    });
    expect(proxy).not.toBeNull();

    // Wired exactly as custom-server.js wires it.
    router = http.createServer((req, res) => {
      if (proxy.handleRequest(req, res)) return;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("next-handled");
    });
    router.on("upgrade", (req, socket, head) => {
      if (proxy.handleUpgrade(req, socket, head)) return;
      socket.destroy();
    });
    await new Promise((r) => router.listen(0, "127.0.0.1", r));
    routerPort = router.address().port;
  });

  afterAll(() => {
    bridge?.close();
    router?.close();
  });

  const get = (urlPath, cookie) => new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: routerPort, path: urlPath, headers: cookie ? { cookie } : {} },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });

  const handshake = (urlPath, cookie) => new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.connect(routerPort, "127.0.0.1", () => {
      socket.write(
        `GET ${urlPath} HTTP/1.1\r\nHost: 127.0.0.1:${routerPort}\r\n`
        + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`
        + (cookie ? `Cookie: ${cookie}\r\n` : "") + "\r\n",
      );
    });
    let buf = Buffer.alloc(0);
    const fail = setTimeout(() => { socket.destroy(); resolve({ status: 0, echoed: null }); }, 5000);
    socket.on("close", () => { clearTimeout(fail); resolve({ status: 0, echoed: null }); });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      const status = Number(buf.slice(0, end).toString().split(" ")[1]);
      clearTimeout(fail);
      if (status !== 101) { socket.destroy(); resolve({ status, echoed: null }); return; }
      const probe = Buffer.from("ping-through-the-proxy");
      let rest = buf.slice(end + 4);
      socket.write(probe);
      const echoFail = setTimeout(() => { socket.destroy(); resolve({ status, echoed: null }); }, 4000);
      socket.on("data", (more) => {
        rest = Buffer.concat([rest, more]);
        if (rest.length < probe.length) return;
        clearTimeout(echoFail);
        socket.destroy();
        resolve({ status, echoed: rest.slice(0, probe.length).toString() });
      });
    });
    socket.on("error", reject);
  });

  it("refuses the console without a dashboard session", async () => {
    const res = await get(`${CHATGPT_WEB_VNC_PREFIX}/vnc.html`, null);
    expect(res.status).toBe(403);
  });

  it("serves the console to a signed-in operator", async () => {
    const res = await get(`${CHATGPT_WEB_VNC_PREFIX}/vnc.html`, `auth_token=${mintToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("noVNC stub /vnc.html");
  });

  it("does not hand the bridge the dashboard session cookie", async () => {
    await get(`${CHATGPT_WEB_VNC_PREFIX}/vnc.html`, `auth_token=${mintToken()}`);
    const last = seen.filter((s) => s.kind === "http").pop();
    expect(last.headers.cookie).toBeUndefined();
  });

  it.each([
    ["a signature from the wrong secret", () => mintToken({ secret: "wrong" })],
    ["an expired token", () => mintToken({ exp: 1 })],
    ['alg "none"', () => mintToken({ alg: "none" })],
    ["a token not marked authenticated", () => mintToken({ authenticated: false })],
    ["a not-yet-valid token", () => mintToken({ nbf: Math.floor(Date.now() / 1000) + 600 })],
  ])("refuses %s", async (_label, make) => {
    const res = await get(`${CHATGPT_WEB_VNC_PREFIX}/vnc.html`, `auth_token=${make()}`);
    expect(res.status).toBe(403);
  });

  it("leaves every other path to Next", async () => {
    const res = await get("/dashboard", `auth_token=${mintToken()}`);
    expect(res.body).toBe("next-handled");
  });

  it("refuses the websocket without a session", async () => {
    const res = await handshake(`${CHATGPT_WEB_VNC_PREFIX}/websockify`, null);
    expect(res.status).not.toBe(101);
  });

  it("bridges the websocket in both directions for a signed-in operator", async () => {
    const res = await handshake(`${CHATGPT_WEB_VNC_PREFIX}/websockify`, `auth_token=${mintToken()}`);
    expect(res.status).toBe(101);
    expect(res.echoed).toBe("ping-through-the-proxy");
    const last = seen.filter((s) => s.kind === "ws").pop();
    expect(last.headers.cookie).toBeUndefined();
    expect(last.headers["sec-websocket-version"]).toBe("13");
  });
});

/**
 * The require in custom-server.js is fail-soft on purpose — a broken console
 * must not stop the router serving traffic. That makes deleted wiring silent,
 * so it is asserted here instead.
 */
describe("server wiring", () => {
  const read = (p) => fs.readFileSync(path.join(REPO_ROOT, p), "utf8");

  it("calls the proxy from the request handler and registers an upgrade listener", () => {
    const source = read("custom-server.js");
    expect(source).toContain("bridge-vnc-proxy.cjs");
    expect(source).toContain("vncProxy.handleRequest(req, res)");
    // Load-bearing: Node only emits "upgrade" when a listener is registered,
    // so without this neither the console nor the h2c downgrade below it runs.
    expect(source).toContain('server.on("upgrade"');
    expect(source).toContain("vncProxy.handleUpgrade(req, socket, head)");
  });

  it("handles the console upgrade inside the emit override, not in a listener", () => {
    // Next's standalone server registers its own upgrade listener, and Node
    // dispatches to every listener — so a socket claimed from a listener gets
    // raced by Next's handler ending it (connects, then drops). Claiming it in
    // the emit override, which returns without calling origEmit, is what keeps
    // it exclusive. Behaviour is covered below; this pins the structure.
    const source = read("custom-server.js");
    expect(source.indexOf("server.emit = function"))
      .toBeLessThan(source.indexOf("vncProxy.handleUpgrade"));
  });

  it("ships the proxy beside custom-server.js in every build path", () => {
    expect(read("scripts/copy-standalone-assets.mjs")).toContain("bridge-vnc-proxy.cjs");
    expect(read("Dockerfile")).toContain("bridge-vnc-proxy.cjs");
    expect(read("cli/scripts/build-cli.js")).toContain("bridge-vnc-proxy.cjs");
  });
});

/**
 * The console's socket must be claimed exclusively. Next's standalone server
 * registers its own upgrade listener (start-server.js), Node dispatches an
 * upgrade to every listener, and Next's handler ends sockets it cannot route —
 * so sharing the event means the console connects and then drops. This wires a
 * server the way custom-server.js wires one, with a hostile second listener
 * standing in for Next.
 */
describe("exclusive ownership of the console socket", () => {
  let bridge;
  let server;
  let port;
  let hostileSaw;

  beforeAll(async () => {
    bridge = http.createServer((_req, res) => res.end("ok"));
    bridge.on("upgrade", (req, socket) => {
      const accept = crypto.createHash("sha1")
        .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on("data", (chunk) => socket.write(chunk));
    });
    await new Promise((r) => bridge.listen(0, "127.0.0.1", r));

    const proxy = createBridgeVncProxy({
      JWT_SECRET: SECRET,
      CHATGPT_WEB_BASE_URL: "http://127.0.0.1:17841",
      CHATGPT_WEB_VNC_PORT: String(bridge.address().port),
    });

    server = http.createServer((_req, res) => res.end("next-handled"));
    server.on("upgrade", (_req, socket) => {
      if (server.listenerCount("upgrade") === 1) socket.destroy();
    });
    const origEmit = server.emit;
    server.emit = function emit(event, ...args) {
      const [req, socket, head] = args;
      if (event === "upgrade" && req?.headers
        && String(req.headers.upgrade || "").toLowerCase() === "websocket"
        && proxy.handleUpgrade(req, socket, head)) {
        return true;
      }
      return origEmit.call(this, event, ...args);
    };
    hostileSaw = [];
    server.on("upgrade", (req, socket) => {
      hostileSaw.push(req.url);
      socket.destroy();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });

  afterAll(() => {
    bridge?.close();
    server?.close();
  });

  const open = (urlPath, cookie, holdMs = 0) => new Promise((resolve, reject) => {
    let status = 0;
    let closedEarly = false;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${urlPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
        + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n`
        + "Sec-WebSocket-Version: 13\r\n"
        + (cookie ? `Cookie: ${cookie}\r\n` : "") + "\r\n",
      );
    });
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end !== -1 && !status) {
        status = Number(buf.slice(0, end).toString().split(" ")[1]);
        if (!holdMs) { socket.destroy(); done({ status, closedEarly }); }
      }
    });
    socket.on("close", () => { closedEarly = true; done({ status, closedEarly }); });
    socket.on("error", reject);
    if (holdMs) setTimeout(() => { socket.destroy(); done({ status, closedEarly }); }, holdMs);
  });

  it("keeps the console upgrade away from every other listener", async () => {
    const res = await open(`${CHATGPT_WEB_VNC_PREFIX}/websockify`, `auth_token=${mintToken()}`);
    expect(res.status).toBe(101);
    expect(hostileSaw).not.toContain(`${CHATGPT_WEB_VNC_PREFIX}/websockify`);
  });

  it("stays open rather than being ended by the other listener", async () => {
    const res = await open(`${CHATGPT_WEB_VNC_PREFIX}/websockify`, `auth_token=${mintToken()}`, 1500);
    expect(res.status).toBe(101);
    expect(res.closedEarly).toBe(false);
  });

  it("still lets unrelated upgrades through to the other listener", async () => {
    await open("/_next/webpack-hmr", `auth_token=${mintToken()}`).catch(() => {});
    expect(hostileSaw).toContain("/_next/webpack-hmr");
  });
});
