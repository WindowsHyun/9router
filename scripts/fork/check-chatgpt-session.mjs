/**
 * The ChatGPT Web session route, against a real Next server.
 *
 *   node scripts/fork/check-chatgpt-session.mjs
 *
 * This is the path that replaced the VNC console: paste a chatgpt.com session
 * in the dashboard, the router normalizes it and hands it to the bridge, the
 * bridge verifies it. A stub stands in for the bridge, so what is exercised
 * here is the router's half — parsing, forwarding, and how each kind of
 * failure is reported.
 *
 * The last two cases matter most. A misconfigured CHATGPT_WEB_BASE_URL makes
 * the URL helper throw, and that used to escape POST and DELETE as an
 * unhandled 500 while GET explained itself politely.
 *
 * Note: booting `next dev` makes Next re-add its agent-rules block to
 * CLAUDE.md. That is expected and not this script's doing — `git checkout --
 * CLAUDE.md` afterwards, or upgrade-fork.mjs will refuse the dirty tree.
 *
 * Takes a few minutes; needs ports 21996, 21997 and 17842 free.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = process.env.ROUTER_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROUTE = "/api/cli-tools/chatgpt-web-session";
const SESSION_PORT = 17842;
const TOKEN = "__Secure-next-auth.session-token";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

// ── the bridge, stubbed ───────────────────────────────────────────────────
let received = null;
let mode = "ok";
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    received = { method: req.method, body: body ? JSON.parse(body) : null };
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && mode === "reject") {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "ChatGPT did not accept that session: expired cookie" }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({
      signedIn: req.method !== "DELETE",
      verifiedAt: "2026-09-22T00:00:00.000Z",
      capabilities: { solAvailable: true, proAvailable: false },
    }));
  });
});

const call = (port, opts, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port, timeout: 180000, ...opts }, (res) => {
    let data = "";
    res.on("data", (c) => { data += c; });
    res.on("end", () => {
      let json = null;
      try { json = JSON.parse(data); } catch { /* keep raw */ }
      resolve({ status: res.statusCode, body: data, json });
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

async function withServer(port, bridgeBaseUrl, body) {
  const dataDir = path.join(os.tmpdir(), `9r-cgw-session-${port}-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env };
  delete env.JWT_SECRET;
  const password = "cgw-session-test-password";
  const server = spawn(process.execPath,
    [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "--webpack", "--port", String(port)], {
      cwd: ROOT,
      env: {
        ...env,
        DATA_DIR: dataDir,
        INITIAL_PASSWORD: password,
        CHATGPT_WEB_BASE_URL: bridgeBaseUrl,
        NODE_OPTIONS: `--require "${path.join(ROOT, "custom-server.js").replace(/\\/g, "/")}"`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  try {
    await waitFor(async () => (await call(port, { method: "GET", path: "/api/health" })).status < 500,
      180000, "next dev to answer");
    return await body({ port, password, log: () => log, server });
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 1000));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Log in and return the cookie header. */
async function session(port) {
  const res = await new Promise((resolve, reject) => {
    const r = http.request({
      host: "127.0.0.1", port, path: "/api/auth/login", method: "POST",
      headers: { "content-type": "application/json" },
    }, (response) => {
      let d = "";
      response.on("data", (c) => { d += c; });
      response.on("end", () => resolve({ headers: response.headers, body: d, status: response.statusCode }));
    });
    r.on("error", reject);
    r.write(JSON.stringify({ password: "cgw-session-test-password" }));
    r.end();
  });
  const m = /auth_token=([^;]+)/.exec([].concat(res.headers["set-cookie"] || []).join("; "));
  if (!m) throw new Error(`login failed: ${res.status} ${res.body.slice(0, 120)}`);
  return `auth_token=${m[1]}`;
}

try {
  await new Promise((r) => stub.listen(SESSION_PORT, "127.0.0.1", r));

  // ── a correctly configured bridge ──────────────────────────────────────
  await withServer(21996, "http://127.0.0.1:17841", async ({ port }) => {
    const cookie = await session(port);
    const json = { cookie, "content-type": "application/json" };

    const status = await call(port, { method: "GET", path: ROUTE, headers: { cookie } });
    check("GET reports the bridge's state", status.json?.signedIn === true && status.json?.reachable === true,
      `status=${status.status} body=${status.body.slice(0, 160)}`);

    received = null;
    const good = await call(port, { method: "POST", path: ROUTE, headers: json },
      JSON.stringify({ session: `${TOKEN}=abc123; _puid=xyz` }));
    check("POST accepts a pasted session", good.json?.signedIn === true,
      `status=${good.status} body=${good.body.slice(0, 160)}`);
    check("the bridge receives normalized Playwright cookies",
      Array.isArray(received?.body?.cookies)
        && received.body.cookies.some((c) => c.name === TOKEN && c.domain && c.path && c.sameSite),
      JSON.stringify(received?.body?.cookies?.[0]));

    received = null;
    const junk = await call(port, { method: "POST", path: ROUTE, headers: json },
      JSON.stringify({ session: "_puid=only" }));
    check("a paste without the session cookie is refused with a reason",
      junk.status === 400 && /httpOnly|devtools/i.test(junk.json?.error || ""),
      `status=${junk.status} error=${junk.json?.error}`);
    check("...and the bridge is never called for it", received === null,
      "the router should reject it before forwarding");

    mode = "reject";
    const rejected = await call(port, { method: "POST", path: ROUTE, headers: json },
      JSON.stringify({ session: `${TOKEN}=stale` }));
    check("a session ChatGPT rejects passes the bridge's reason through",
      rejected.status === 400 && /expired cookie/.test(rejected.json?.error || ""),
      `status=${rejected.status} error=${rejected.json?.error}`);
    mode = "ok";

    const out = await call(port, { method: "DELETE", path: ROUTE, headers: { cookie } });
    check("DELETE signs out", out.json?.signedIn === false, `body=${out.body.slice(0, 120)}`);

    // The cards themselves. API checks never compile them, so a bad import or
    // a typo in the JSX would sail through everything else and surface only
    // when somebody opened the page.
    //
    // The cards mount client-side once the provider loads, so their text is
    // not in the server HTML — what is checkable here is that the route
    // compiled at all. next dev answers a compile error with an error payload,
    // not a rendered document.
    for (const provider of ["chatgpt-web", "claude-cli"]) {
      const page = await call(port, {
        method: "GET",
        path: `/dashboard/providers/${provider}`,
        headers: { cookie },
      });
      const broken = /Failed to compile|Module not found|__next_error__|Internal Server Error/i
        .test(page.body);
      check(`the ${provider} provider page compiles`,
        page.status === 200 && page.body.length > 1000 && !broken,
        `status=${page.status} len=${page.body.length} broken=${broken}`);
    }
  });

  // ── a misconfigured bridge: the URL helper throws ──────────────────────
  await withServer(21997, "http://evil.example.com:17841", async ({ port }) => {
    const cookie = await session(port);
    const json = { cookie, "content-type": "application/json" };
    for (const [method, body] of [
      ["GET", null],
      ["POST", JSON.stringify({ session: `${TOKEN}=abc` })],
      ["DELETE", null],
    ]) {
      const res = await call(port, { method, path: ROUTE, headers: method === "POST" ? json : { cookie } }, body);
      check(`${method} explains a misconfigured bridge instead of failing`,
        res.status < 500 && /private network|loopback|not reachable|answered/i.test(
          `${res.json?.error || ""}${res.json?.hint || ""}`,
        ),
        `status=${res.status} body=${res.body.slice(0, 200)}`);
    }
  });
} catch (e) {
  check("harness completed", false, e.message);
} finally {
  stub.close();
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
