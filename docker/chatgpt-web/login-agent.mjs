/**
 * The sign-in console, on demand.
 *
 * Signing in to chatgpt.com needs a browser a human can see, but *only* to sign
 * in — the bridge runs headless afterwards. The previous image kept Xvfb,
 * x11vnc, noVNC and an Electron launcher resident forever to serve that one
 * moment, which is what made the pod heavy.
 *
 * So nothing starts until someone opens this port. The first request brings up
 * Xvfb, x11vnc, websockify and `codex-chatgpt-web login`; everything is torn
 * down again when the login finishes, or when the console has been idle. Steady
 * state is a bun process and a headless Chromium, and this agent asleep.
 *
 * It listens on VNC_PORT and reverse-proxies to websockify on loopback, so
 * 9Router's existing console proxy points at it unchanged.
 *
 * Note on the flow: `loginToChatGpt` spawns a normal Chrome window and waits
 * for the user to QUIT it before capturing the session. That is upstream's
 * design, not a quirk of this container — the dashboard card says so.
 */
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const VNC_PORT = Number(process.env.VNC_PORT || 6080);
const DISPLAY = process.env.LOGIN_DISPLAY || ":99";
const RFB_PORT = Number(process.env.LOGIN_RFB_PORT || 5901);
const WEBSOCKIFY_PORT = Number(process.env.LOGIN_WEBSOCKIFY_PORT || 6081);
const IDLE_TIMEOUT_MS = Number(process.env.LOGIN_IDLE_TIMEOUT_SEC || 900) * 1000;
const BRIDGE_ROOT = process.env.BRIDGE_ROOT || "/opt/codex-chatgpt-web";
const NOVNC_ROOT = process.env.NOVNC_ROOT || "/usr/share/novnc";

const log = (...args) => console.log("[login-agent]", ...args);

/** Everything the sign-in needs, and nothing that outlives it. */
const stack = {
  state: "idle", // idle | starting | up | finishing
  procs: [],
  loginExit: null,
  lastSeen: Date.now(),
  liveSockets: 0,
  startPromise: null,
};

function spawnTracked(name, command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  child.stdout?.on("data", (d) => log(`${name}:`, String(d).trim().slice(0, 500)));
  child.stderr?.on("data", (d) => log(`${name}:`, String(d).trim().slice(0, 500)));
  child.on("error", (e) => log(`${name} failed to start:`, e.message));
  stack.procs.push({ name, child });
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const canConnect = (port) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
  setTimeout(() => { s.destroy(); resolve(false); }, 1000);
});

const displayReady = () => new Promise((resolve) => {
  const p = spawn("xdpyinfo", ["-display", DISPLAY], { stdio: "ignore" });
  p.on("exit", (code) => resolve(code === 0));
  p.on("error", () => resolve(false));
});

async function startStack() {
  stack.state = "starting";
  stack.loginExit = null;
  log("starting the sign-in console");

  // In headed mode the entrypoint already owns a display for the bridge's own
  // Chrome, and the sign-in browser shares it. Starting a second X server on
  // the same DISPLAY would fail, and killing that one on teardown would take
  // the bridge's browser with it — so only start one if nothing is there.
  // Anything not spawned here is not in stack.procs, and so is never stopped.
  if (await displayReady()) {
    log(`reusing the existing display ${DISPLAY}`);
  } else {
    spawnTracked("Xvfb", "Xvfb", [DISPLAY, "-screen", "0", "1280x800x24", "-nolisten", "tcp"]);
    await waitFor(displayReady, 20000, "Xvfb");
  }

  // -localhost: the RFB port is never exposed; websockify in front of it is
  // what this agent proxies, and 9Router gates that behind its own session.
  spawnTracked("x11vnc", "x11vnc", [
    "-display", DISPLAY, "-forever", "-shared", "-nopw", "-quiet",
    "-localhost", "-rfbport", String(RFB_PORT),
  ]);
  await waitFor(() => canConnect(RFB_PORT), 20000, "x11vnc");

  spawnTracked("websockify", "websockify", [
    "--web", NOVNC_ROOT, `127.0.0.1:${WEBSOCKIFY_PORT}`, `127.0.0.1:${RFB_PORT}`,
  ]);
  await waitFor(() => canConnect(WEBSOCKIFY_PORT), 20000, "websockify");

  // The bridge's own login command: opens Chrome on this display, waits for the
  // user to quit it, then captures and verifies the storage state.
  const login = spawnTracked("login", "bun", ["run", `${BRIDGE_ROOT}/src/cli.ts`, "login"], {
    env: { ...process.env, DISPLAY },
    cwd: BRIDGE_ROOT,
  });
  login.on("exit", (code) => {
    stack.loginExit = code ?? 1;
    log(`login exited with ${stack.loginExit}`);
    // Success or failure, the desktop has done its job.
    stopStack(code === 0 ? "login completed" : "login exited");
  });

  stack.state = "up";
  stack.lastSeen = Date.now();
  log("console ready");
}

function ensureUp() {
  stack.lastSeen = Date.now();
  if (stack.state === "up") return Promise.resolve();
  if (!stack.startPromise) {
    stack.startPromise = startStack().catch((error) => {
      log("failed to start:", error.message);
      stopStack("start failed");
      throw error;
    }).finally(() => { stack.startPromise = null; });
  }
  return stack.startPromise;
}

function stopStack(reason) {
  if (stack.state === "idle") return;
  stack.state = "finishing";
  log(`stopping (${reason})`);
  for (const { name, child } of stack.procs.reverse()) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    log(`  stopped ${name}`);
  }
  stack.procs = [];
  stack.state = "idle";
  stack.liveSockets = 0;
}

// Idle teardown: a console nobody is watching costs memory for nothing.
setInterval(() => {
  if (stack.state !== "up") return;
  if (stack.liveSockets > 0) { stack.lastSeen = Date.now(); return; }
  if (Date.now() - stack.lastSeen > IDLE_TIMEOUT_MS) stopStack("idle");
}, 15000).unref?.();

const storageStatePath = () => {
  const home = process.env.CODEX_CHATGPT_WEB_HOME || "/data/profile";
  return `${home}/browser/storage-state.json`;
};

const server = http.createServer(async (req, res) => {
  if (req.url === "/status" || req.url?.startsWith("/status?")) {
    const signedIn = existsSync(storageStatePath())
      && existsSync(`${storageStatePath()}.verified.json`);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      console: stack.state,
      signedIn,
      lastLoginExit: stack.loginExit,
      idleTimeoutSec: IDLE_TIMEOUT_MS / 1000,
    }));
    return;
  }

  try {
    await ensureUp();
  } catch (error) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end(`The sign-in console could not start.\n${error.message}\n`);
    return;
  }

  const upstream = http.request({
    host: "127.0.0.1",
    port: WEBSOCKIFY_PORT,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${WEBSOCKIFY_PORT}` },
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", (error) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Console backend unavailable: ${error.message}\n`);
  });
  req.pipe(upstream);
});

server.on("upgrade", async (req, socket, head) => {
  try {
    await ensureUp();
  } catch {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  stack.liveSockets += 1;
  const done = () => {
    stack.liveSockets = Math.max(0, stack.liveSockets - 1);
    stack.lastSeen = Date.now();
  };
  socket.once("close", done);

  const upstream = net.connect(WEBSOCKIFY_PORT, "127.0.0.1", () => {
    const lines = [`GET ${req.url} HTTP/1.1`, `Host: 127.0.0.1:${WEBSOCKIFY_PORT}`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "host") continue;
      if (Array.isArray(value)) for (const v of value) lines.push(`${key}: ${v}`);
      else lines.push(`${key}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => { socket.destroy(); });
  socket.on("error", () => { upstream.destroy(); });
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { stopStack(signal); process.exit(0); });
}

server.listen(VNC_PORT, "0.0.0.0", () => {
  log(`listening on :${VNC_PORT} — the console starts when it is first opened`);
  log(`idle teardown after ${IDLE_TIMEOUT_MS / 1000}s with nobody connected`);
});
