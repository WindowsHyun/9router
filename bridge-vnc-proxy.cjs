"use strict";
/**
 * Serves the ChatGPT Web bridge's noVNC console through 9Router's own origin.
 *
 * Why this exists
 * ---------------
 * Signing in to chatgpt.com has to happen in a real browser window, and that
 * window belongs to the bridge's Electron launcher on its virtual display. The
 * dashboard's old "Login" button called the `open` npm package server-side,
 * which opens a browser **on the machine running Node**. On a desktop that
 * works; in a container there is no browser, no DISPLAY and usually no
 * xdg-open, so the click produced nothing at all — the reported symptom.
 *
 * The only other route to that window was `kubectl port-forward 6080`, which
 * makes a cluster tool a prerequisite for using the feature at all.
 *
 * So the router proxies the bridge's noVNC here: the dashboard opens
 * `<prefix>/vnc.html` on the origin the operator is already signed in to, and
 * the launcher window appears in their browser. No port-forward, no kubectl,
 * nothing published to the network that was not already published.
 *
 * Why it lives in CJS beside custom-server.js
 * -------------------------------------------
 * noVNC needs a WebSocket, and Next.js route handlers cannot upgrade one.
 * custom-server.js already owns the raw HTTP server and already intercepts the
 * `upgrade` event, so this is the only place the socket can be bridged. It is
 * `.cjs` and self-contained because the production image copies
 * `custom-server.js` and `open-sse/` but **not** `src/` (see Dockerfile) — so
 * `require`-ing the app's own session helper is not an option there.
 *
 * Access control
 * --------------
 * That console is a live desktop logged into the operator's ChatGPT account.
 * It is gated on a valid dashboard session cookie, always — independent of the
 * `requireLogin` setting, like the ALWAYS_PROTECTED routes. Next's middleware
 * never sees these requests (this handler answers before Next is called), so
 * the check is performed here rather than inherited.
 */

const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Kept in sync with CHATGPT_WEB_VNC_PREFIX in open-sse/config/chatgptWeb.js.
// tests/unit/chatgpt-web-vnc-proxy.test.js asserts the two agree.
const PREFIX = "/api/cli-tools/chatgpt-web-vnc";
const DEFAULT_VNC_PORT = 6080;
const COOKIE_NAME = "auth_token";

// Hop-by-hop headers must not be forwarded (RFC 7230 6.1).
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

/**
 * A deliberate duplicate of isPrivateNetworkHost() in
 * open-sse/config/chatgptWeb.js, which is ESM and cannot be require()d from
 * here. The duplication is covered by a test that runs both implementations
 * over the same host table, so the two cannot drift apart silently.
 */
function isPrivateHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (!host.includes(".") && !host.includes(":")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return false;
    const [a, b] = parts;
    // 169.254/16 is excluded on purpose: 169.254.169.254 is the cloud metadata
    // service, and "private" does not make it a valid bridge.
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

/**
 * Where the bridge's noVNC lives, derived from the same variable that routed
 * traffic uses so there is nothing extra to configure in the common case:
 * CHATGPT_WEB_BASE_URL's host with the noVNC port.
 *
 * Returns null when no bridge is configured — a desktop install proxies
 * nothing, and the prefix then falls through to Next (a 404 behind the guard).
 */
function resolveTarget(env) {
  const explicit = String(env.CHATGPT_WEB_VNC_URL || "").trim();
  const base = String(env.CHATGPT_WEB_BASE_URL || "").trim();
  const raw = explicit || base;
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!isPrivateHost(url.hostname)) return null;

  let port;
  if (explicit && url.port) {
    port = Number(url.port);
  } else {
    port = Number(env.CHATGPT_WEB_VNC_PORT || DEFAULT_VNC_PORT);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { host: url.hostname, port, tls: url.protocol === "https:" };
}

/** DATA_DIR, matching src/lib/dataDir.js so the same jwt-secret file is found. */
function dataDir(env) {
  const configured = String(env.DATA_DIR || "").trim();
  if (configured && !(process.platform === "win32" && /^\//.test(configured))) return configured;
  if (process.platform === "win32") {
    return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

/**
 * The dashboard's JWT secret. Read lazily and never generated here: the app
 * creates it at boot, and minting a different one would silently reject every
 * real session. Not cached negatively, so a later boot is picked up.
 */
let cachedSecret = null;
function loadJwtSecret(env) {
  if (cachedSecret) return cachedSecret;
  if (env.JWT_SECRET) {
    cachedSecret = env.JWT_SECRET;
    return cachedSecret;
  }
  try {
    const value = fs.readFileSync(path.join(dataDir(env), "jwt-secret"), "utf8").trim();
    if (value) cachedSecret = value;
    return cachedSecret;
  } catch {
    return null;
  }
}

function b64urlToBuffer(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Verify the dashboard session cookie: HS256 only, signature checked in
 * constant time, expiry enforced, and `authenticated` required so a token
 * minted for some other purpose cannot open the console.
 *
 * Deliberately stdlib-only — see the module header on why jose is not
 * available to this file in the production image.
 */
function hasValidSession(req, env) {
  const token = readCookie(req.headers.cookie, COOKIE_NAME);
  if (!token) return false;
  const secret = loadJwtSecret(env);
  if (!secret) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(b64urlToBuffer(encodedHeader).toString("utf8"));
    payload = JSON.parse(b64urlToBuffer(encodedPayload).toString("utf8"));
  } catch {
    return false;
  }
  // Pin the algorithm: accepting whatever the token asks for is how "alg":"none"
  // and RS256→HS256 confusion turn a verifier into a rubber stamp.
  if (!header || header.alg !== "HS256") return false;
  if (!payload || payload.authenticated !== true) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const actual = b64urlToBuffer(encodedSignature);
  if (actual.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(actual, expected)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now >= payload.exp) return false;
  if (typeof payload.nbf === "number" && now < payload.nbf) return false;
  return true;
}

/**
 * The upstream path for a proxied request. Returns null for anything that
 * escapes the prefix; websockify's static handler normalizes traversal itself,
 * but refusing it here keeps that assumption out of the trust chain.
 */
function upstreamPath(requestUrl) {
  const suffix = requestUrl.slice(PREFIX.length) || "/";
  if (!suffix.startsWith("/")) return null;
  const [pathname] = suffix.split("?");
  if (pathname.split("/").includes("..")) return null;
  return suffix;
}

function forwardableHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    // The bridge has no use for the dashboard session and must not receive it.
    if (name === "cookie" || name === "authorization") continue;
    // Stamped by custom-server.js for 9Router's own handlers.
    if (name.startsWith("x-9r-")) continue;
    if (name === "host") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Creates the proxy, or returns null when no bridge is configured.
 */
function createBridgeVncProxy(env = process.env) {
  const target = resolveTarget(env);
  if (!target) return null;
  if (target.tls) return null; // websockify here is plain http; refuse rather than pretend

  const matches = (url) => {
    if (typeof url !== "string") return false;
    return url === PREFIX || url.startsWith(`${PREFIX}/`) || url.startsWith(`${PREFIX}?`);
  };

  const DENIED =
    "Sign in to 9Router first, then open the bridge console from the dashboard.\n"
    + "This console always requires a dashboard login, even if login is otherwise\n"
    + "disabled: it is a live desktop signed into your ChatGPT account.\n";

  const deny = (res) => {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(DENIED);
  };

  function handleRequest(req, res) {
    if (!matches(req.url)) return false;
    if (!hasValidSession(req, env)) {
      deny(res);
      return true;
    }
    const suffix = upstreamPath(req.url);
    if (suffix === null) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad path\n");
      return true;
    }

    const upstream = http.request({
      host: target.host,
      port: target.port,
      method: req.method,
      path: suffix,
      headers: { ...forwardableHeaders(req.headers), host: `${target.host}:${target.port}` },
    }, (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      delete headers.connection;
      delete headers["transfer-encoding"];
      res.writeHead(upstreamRes.statusCode || 502, headers);
      upstreamRes.pipe(res);
    });

    upstream.on("error", (error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        `The ChatGPT Web bridge console is not answering at ${target.host}:${target.port}.\n`
        + `${error.message}\n`,
      );
    });
    req.pipe(upstream);
    return true;
  }

  function handleUpgrade(req, socket, head) {
    if (!matches(req.url)) return false;
    if (!hasValidSession(req, env)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    const suffix = upstreamPath(req.url);
    if (suffix === null) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }

    const upstream = net.connect(target.port, target.host, () => {
      const lines = [`GET ${suffix} HTTP/1.1`, `Host: ${target.host}:${target.port}`];
      // Re-send the handshake verbatim apart from Host/Cookie: the Sec-WebSocket-*
      // values are what websockify keys its 101 on, and the browser validates the
      // accept hash against the key it sent.
      for (const [key, value] of Object.entries(req.headers)) {
        const name = key.toLowerCase();
        if (name === "host" || name === "cookie" || name === "authorization") continue;
        if (name.startsWith("x-9r-")) continue;
        if (Array.isArray(value)) for (const v of value) lines.push(`${key}: ${v}`);
        else lines.push(`${key}: ${value}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      // After the 101 this is an opaque byte stream in both directions.
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    const shutdown = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on("error", () => {
      if (!socket.destroyed) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
      shutdown();
    });
    socket.on("error", shutdown);
    return true;
  }

  return { prefix: PREFIX, target, matches, handleRequest, handleUpgrade };
}

module.exports = {
  createBridgeVncProxy,
  // exported for tests
  PREFIX,
  isPrivateHost,
  resolveTarget,
  hasValidSession,
  upstreamPath,
  forwardableHeaders,
};
