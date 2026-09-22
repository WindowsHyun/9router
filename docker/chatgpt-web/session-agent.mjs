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
 * and this writes the state and then verifies it the way upstream does — using
 * the bridge's own assertions and capability probe, which open the account in
 * a real browser and read back which models it can use.
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
  storedBrowserLoginCapabilities,
} = await import(`${BRIDGE_ROOT}/src/browser-login`);
const {
  CHATGPT_TEMPORARY_CHAT_URL,
  CHATGPT_COMPOSER_SELECTOR,
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  detectChatGptAccountCapabilities,
} = await import(`${BRIDGE_ROOT}/src/chatgpt-session`);
const { chromium } = await import(`${BRIDGE_ROOT}/node_modules/playwright-core/index.js`);

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

/** Cloudflare's interstitial, in whatever language the account is set to. */
const CHALLENGE = /just a moment|checking your browser|잠시만|un momento|einen moment/i;

/**
 * Verify the stored session by opening the account, the way upstream does —
 * with one line replaced.
 *
 * Upstream's `inspectBrowserLoginCapabilities` waits for a textbox whose
 * *accessible name* is the English string "Chat with ChatGPT". On an account
 * whose UI is not English that never matches: a Korean account's composer is
 * labelled "ChatGPT와 채팅", so verification times out after 60s and a working
 * session gets reported as rejected. Their own login path does not have this
 * problem, because it falls back to a CSS selector — this uses that same
 * locale-independent selector, which they export for exactly this purpose.
 *
 * Everything else here is theirs: the assertions and the capability probe.
 *
 * Cloudflare is called out separately. A challenge that never clears is a
 * different problem with a different fix (usually headless, or an address the
 * bot management does not like), and reporting it as a bad session would send
 * someone off to re-copy a cookie that was fine.
 */
async function verifyStoredSession(config) {
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: !config.headed,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const context = await browser.newContext({ storageState: config.storageStatePath });
    try {
      const page = await context.newPage();
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

      // The composer appearing is the signal. Poll rather than one long wait,
      // so a stuck challenge can be named instead of timing out anonymously.
      const deadline = Date.now() + 90_000;
      let challenged = false;
      for (;;) {
        if (await page.locator(CHATGPT_COMPOSER_SELECTOR).first().isVisible().catch(() => false)) break;
        challenged = CHALLENGE.test(await page.title().catch(() => ""));
        if (Date.now() > deadline) {
          throw new Error(challenged
            ? "Cloudflare did not let the browser through (its challenge page never cleared). "
              + "The session itself may be fine. This is what happens when the bridge runs "
              + "headless, so check BRIDGE_HEADLESS is not set, and note that some hosting "
              + "addresses are challenged regardless."
            : "the ChatGPT composer never appeared, so the account did not load signed in");
        }
        await page.waitForTimeout(2_000);
      }

      await assertAuthenticatedChatGptPage(page);
      await assertTemporaryChatPage(page);
      const capabilities = await detectChatGptAccountCapabilities(page);
      log(`verified on ${page.url()}`);
      return capabilities;
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
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

  try {
    const capabilities = await verifyStoredSession(config);
    // Written only now, and only with what the account really has. Nothing
    // reports itself signed in until the browser has proved it.
    atomicWriteFile(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({
        version: 1,
        authenticated: true,
        verifiedAt: new Date().toISOString(),
        ...capabilities,
      })}\n`,
    );
    log("session verified:", JSON.stringify(capabilities));
    return { ...status(), capabilities };
  } catch (error) {
    forget(config);
    // Not always the session's fault, so do not insist that it is — the
    // message from verifyStoredSession distinguishes a Cloudflare challenge
    // from an account that loaded signed out.
    throw new Error(`Could not verify that session: ${error.message}`);
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
