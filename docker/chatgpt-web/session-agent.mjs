/**
 * Sign the bridge in from 9Router, with no desktop anywhere.
 *
 * The bridge authenticates from a Playwright storage state at
 * `storageStatePath` and a `.verified.json` marker beside it. Producing those
 * used to mean a human driving a browser *inside this container*, which is
 * why it carried Xvfb, x11vnc, noVNC and — before that — an Electron launcher.
 *
 * None of that is inherent. The storage state is cookies, and cookies can be
 * handed over. So the dashboard collects a chatgpt.com session, posts it here,
 * and this writes the state and then verifies it the way upstream does —
 * with the bridge's own `inspectBrowserLoginCapabilities`, which opens the
 * account in a real browser and reads back which models it can use.
 *
 * That verification is the point. Writing cookies to disk and hoping would
 * hand back a green light that means nothing; this only reports success if
 * ChatGPT actually answered as a signed-in account.
 *
 *   GET    /session  → { signedIn, capabilities, verifiedAt }
 *   POST   /session  → { cookies, origins } , verifies, returns capabilities
 *   DELETE /session  → forget it
 */
import http from "node:http";
import fs from "node:fs";

const BRIDGE_ROOT = process.env.BRIDGE_ROOT || "/opt/codex-chatgpt-web";
const PORT = Number(process.env.SESSION_PORT || 17842);
const MAX_BODY_BYTES = 512 * 1024;

const { loadConfig, atomicWriteFile } = await import(`${BRIDGE_ROOT}/src/config`);
const {
  sanitizeBrowserLoginStorageState,
  loginVerificationMarkerPath,
  browserLoginStateExists,
  inspectBrowserLoginCapabilities,
  storedBrowserLoginCapabilities,
} = await import(`${BRIDGE_ROOT}/src/browser-login`);

const log = (...a) => console.log("[session-agent]", ...a);

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      reject(new Error("Session payload is too large"));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

function status() {
  const config = loadConfig();
  const signedIn = browserLoginStateExists(config);
  let verifiedAt = null;
  if (signedIn) {
    try {
      verifiedAt = JSON.parse(fs.readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")).verifiedAt;
    } catch { /* the marker is optional detail */ }
  }
  return {
    signedIn,
    verifiedAt,
    capabilities: signedIn ? storedBrowserLoginCapabilities(config) : {},
    storageStatePath: config.storageStatePath,
  };
}

function forget(config) {
  for (const p of [config.storageStatePath, loginVerificationMarkerPath(config.storageStatePath)]) {
    try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
  }
}

async function connect(payload) {
  const config = loadConfig();
  const state = sanitizeBrowserLoginStorageState({
    cookies: Array.isArray(payload?.cookies) ? payload.cookies : [],
    origins: Array.isArray(payload?.origins) ? payload.origins : [],
  });
  if (state.cookies.length === 0) {
    throw new Error("No cookies for chatgpt.com or openai.com survived validation");
  }

  atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
  // inspectBrowserLoginCapabilities refuses to run unless the state already
  // looks verified, so this provisional marker is what lets it open the
  // account at all. It is replaced by the real one on success, and deleted
  // along with the state on failure — a half-written session that reports
  // itself as signed in would be worse than none.
  atomicWriteFile(
    loginVerificationMarkerPath(config.storageStatePath),
    `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: new Date().toISOString() })}\n`,
  );

  try {
    const capabilities = await inspectBrowserLoginCapabilities(config);
    log("session verified:", JSON.stringify(capabilities));
    return { ...status(), capabilities };
  } catch (error) {
    forget(config);
    throw new Error(
      `ChatGPT did not accept that session: ${error.message}. `
      + "The cookies may be expired, from a different account, or missing "
      + "__Secure-next-auth.session-token.",
    );
  }
}

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = (req.url || "").split("?")[0];
  if (url !== "/session" && url !== "/healthz") {
    send(res, 404, { error: "Not found" });
    return;
  }
  try {
    if (url === "/healthz") {
      send(res, 200, { ok: true });
    } else if (req.method === "GET") {
      send(res, 200, status());
    } else if (req.method === "POST") {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        send(res, 400, { error: "Body is not valid JSON" });
        return;
      }
      send(res, 200, await connect(payload));
    } else if (req.method === "DELETE") {
      forget(loadConfig());
      send(res, 200, status());
    } else {
      send(res, 405, { error: "Method not allowed" });
    }
  } catch (error) {
    log("failed:", error.message);
    send(res, 400, { error: error.message });
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { server.close(); process.exit(0); });
}

// Reachable from the router, which is a sidecar on the same pod (loopback) or
// a sibling container. Never published outside the deployment: it accepts a
// ChatGPT session, and 9Router gates the dashboard route in front of it.
server.listen(PORT, "0.0.0.0", () => {
  log(`listening on :${PORT} — POST /session to sign in, GET /session for status`);
});
