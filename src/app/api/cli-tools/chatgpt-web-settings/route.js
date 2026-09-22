"use server";

import { NextResponse } from "next/server";
import {
  CHATGPT_WEB_DEFAULT_BASE_URL,
  CHATGPT_WEB_HEALTH_PATH,
  CHATGPT_WEB_INSTALL_URL,
  CHATGPT_WEB_MODELS_PATH,
  CHATGPT_WEB_MODEL_PREFIX,
  assertBridgeBaseUrl,
  resolveChatGptWebBaseUrl,
} from "open-sse/config/chatgptWeb.js";

const PROBE_TIMEOUT_MS = 4000;

// The caller supplies this value, so it is constrained to a loopback origin:
// otherwise this route is a server-side request forgery primitive that reports
// status codes, timing and response fragments back to the caller.
/**
 * Where to probe.
 *
 * An explicit value from the card wins; otherwise fall back to the SAME place
 * routed traffic goes. assertBridgeBaseUrl alone resolves an empty value to
 * the 127.0.0.1 default, so with the bridge deployed as a sibling container
 * this route probed the router's own loopback, found nothing, and reported
 * "Bridge offline" while routing worked perfectly.
 */
function normalizeBaseUrl(value) {
  if (typeof value === "string" && value.trim()) return assertBridgeBaseUrl(value);
  return resolveChatGptWebBaseUrl(null);
}

/**
 * Where the probed address came from.
 *
 * Without this, "Bridge offline" covered both "the bridge is down" and "we are
 * probing the wrong host because CHATGPT_WEB_BASE_URL is not set" — and the
 * card could not tell them apart, so neither could anyone reading it.
 */
function baseUrlSource(requested) {
  if (typeof requested === "string" && requested.trim()) return "this field";
  return process.env.CHATGPT_WEB_BASE_URL ? "CHATGPT_WEB_BASE_URL" : "the built-in default";
}

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // The bridge binds to loopback; never route this through an outbound proxy,
    // and never follow a redirect off it.
    const response = await fetch(url, { signal: controller.signal, cache: "no-store", redirect: "manual" });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* health payloads may be plain text */ }
    return { ok: response.ok, status: response.status, json, text: text.slice(0, 500) };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Status for the ChatGPT Web bridge (codex-chatgpt-web).
 *
 * The ChatGPT sign-in window belongs to the bridge's own Electron app, so this
 * route reports whether that daemon is up and which routed models its
 * authenticated session currently exposes — that is what "logged in" means here.
 */
export async function GET(request) {
  // The batch status endpoint calls this with no request object.
  let requestedBaseUrl = null;
  try { requestedBaseUrl = new URL(request.url).searchParams.get("baseUrl"); } catch { /* batch call */ }

  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(requestedBaseUrl);
  } catch (e) {
    return NextResponse.json({
      installed: false, running: false, models: [],
      baseUrl: CHATGPT_WEB_DEFAULT_BASE_URL,
      installUrl: CHATGPT_WEB_INSTALL_URL,
      error: e.message,
    }, { status: 400 });
  }

  const source = baseUrlSource(requestedBaseUrl);
  const health = await probe(`${baseUrl}${CHATGPT_WEB_HEALTH_PATH}`);
  if (!health.ok) {
    return NextResponse.json({
      installed: false,
      running: false,
      baseUrl,
      baseUrlSource: source,
      models: [],
      installUrl: CHATGPT_WEB_INSTALL_URL,
      error: health.error || `Daemon not reachable (HTTP ${health.status})`,
      hint: `Nothing answered /healthz at ${baseUrl} (from ${source}).`,
    });
  }

  const catalog = await probe(`${baseUrl}${CHATGPT_WEB_MODELS_PATH}`);
  const rows = Array.isArray(catalog.json?.data) ? catalog.json.data : [];
  const models = rows
    .map((row) => row?.id)
    .filter((id) => typeof id === "string" && id.startsWith(CHATGPT_WEB_MODEL_PREFIX));

  return NextResponse.json({
    installed: true,
    running: true,
    baseUrl,
    version: health.json?.version || null,
    // An authenticated session is what makes the bridge advertise its own rows.
    signedIn: models.length > 0,
    models,
    installUrl: CHATGPT_WEB_INSTALL_URL,
    error: catalog.ok ? null : `Model catalog unavailable (HTTP ${catalog.status})`,
    hint: models.length > 0
      ? null
      : "Daemon is up but exposes no chatgpt-web/* model — click Login and sign in to ChatGPT in the launcher window.",
  });
}
