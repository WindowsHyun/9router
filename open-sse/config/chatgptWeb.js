/**
 * ChatGPT Web bridge (miuuyy/codex-chatgpt-web).
 *
 * That project drives a real, user-authenticated ChatGPT web session in an
 * Electron/Playwright tab and exposes it on loopback as an OpenAI **Responses**
 * API. 9Router consumes that daemon rather than re-implementing the browser
 * automation or the sentinel/PoW handshake that a raw HTTP path would need.
 *
 * Daemon surface (verified against codex-chatgpt-web 5.0.8):
 *   POST http://127.0.0.1:17841/v1/responses   — Responses API, no auth on loopback
 *   GET  http://127.0.0.1:17841/v1/models      — official catalog + chatgpt-web/* rows
 *   GET  http://127.0.0.1:17841/healthz        — liveness + version payload
 */

// PROVIDER_MODELS is keyed by `alias || id`, so upstream-id lookups must use this.
export const CHATGPT_WEB_ALIAS = "cgw";

export const CHATGPT_WEB_DEFAULT_BASE_URL = "http://127.0.0.1:17841";
export const CHATGPT_WEB_RESPONSES_PATH = "/v1/responses";
export const CHATGPT_WEB_MODELS_PATH = "/v1/models";
export const CHATGPT_WEB_HEALTH_PATH = "/healthz";

// The daemon namespaces its routed rows; ids are advertised with this prefix.
export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";

export const CHATGPT_WEB_INSTALL_URL = "https://github.com/miuuyy/codex-chatgpt-web";

/**
 * The daemon binds to loopback only. An outbound HTTP proxy configured for real
 * upstreams must not be applied to it, or every request dies in the proxy.
 */
export function isLoopbackUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
      || hostname === "[::1]"
      || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

// src/sse/services/auth.js injects this placeholder token for every noAuth
// provider. It is not a credential and must never reach the bridge.
export const NOAUTH_TOKEN_SENTINEL = "public";

/**
 * The bridge binds to loopback by its own security model, and this value decides
 * where a request (and any bearer token on it) is sent — so it is validated as a
 * loopback http(s) origin rather than concatenated blindly.
 * @returns {string} normalized origin
 * @throws {Error} when the configured value is not a usable loopback URL
 */
export function assertBridgeBaseUrl(raw) {
  const value = String(raw || "").trim() || CHATGPT_WEB_DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ChatGPT Web bridge URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ChatGPT Web bridge URL must be http or https");
  }
  if (!isLoopbackUrl(url.href)) {
    throw new Error("ChatGPT Web bridge must be reachable on loopback (forward a remote bridge to 127.0.0.1)");
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Where routed traffic goes.
 *
 * `chatgpt-web` is a noAuth provider, so src/sse/services/auth.js hands the
 * executor a synthetic connection with no providerSpecificData of its own — a
 * per-connection override would silently never apply. CHATGPT_WEB_BASE_URL is
 * the knob that actually works; the credentials path stays first so a future
 * real connection keeps working.
 */
export function resolveChatGptWebBaseUrl(credentials) {
  return assertBridgeBaseUrl(
    credentials?.providerSpecificData?.baseUrl || process.env.CHATGPT_WEB_BASE_URL,
  );
}

export function chatGptWebResponsesUrl(credentials) {
  return `${resolveChatGptWebBaseUrl(credentials)}${CHATGPT_WEB_RESPONSES_PATH}`;
}

// Fields the Responses API accepts; anything else is dropped before dispatch.
export const CHATGPT_WEB_RESPONSES_ALLOWLIST = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "stream", "store",
  "reasoning", "include", "text", "parallel_tool_calls", "max_output_tokens",
  "temperature", "top_p", "metadata", "prompt_cache_key",
]);
