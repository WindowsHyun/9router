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
 * True for a host that cannot be on the public internet: loopback, an RFC1918
 * or CGNAT address, a link-local address, or a bare name with no dot — which
 * is what a Docker service (`http://chatgpt-web:17841`) or a Kubernetes
 * service looks like.
 */
function isPrivateNetworkHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  // A single label cannot resolve on the public internet; it is a container or
  // LAN name. "chatgpt-web" is exactly this case.
  if (!host.includes(".") && !host.includes(":")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    // 169.254/16 is deliberately absent: it is link-local, and 169.254.169.254
    // is the cloud metadata service. "Private" does not make it a valid bridge,
    // and allowing it would turn this setting into an SSRF primitive.
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // IPv6 unique-local / link-local
  // Unique-local only; fe80:: link-local is excluded for the same reason as 169.254.
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

/**
 * Where a request — and any bearer token on it — gets sent, so it is validated
 * rather than concatenated blindly.
 *
 * Loopback was the only accepted answer originally, which was right while the
 * bridge could only be a desktop app on the same machine. It also made the
 * supported Docker layout impossible: there the bridge is a sibling container
 * reached as `http://chatgpt-web:17841`. The rule is now "must not be a public
 * host", which still refuses to ship the session anywhere off the machine or
 * its private network.
 * @returns {string} normalized origin
 * @throws {Error} when the configured value is not a usable private URL
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
  if (!isLoopbackUrl(url.href) && !isPrivateNetworkHost(url.hostname)) {
    throw new Error(
      `ChatGPT Web bridge must be on loopback or a private network, not ${url.hostname}. `
      + "Forward a remote bridge to 127.0.0.1, or use its container/LAN address.",
    );
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

// The bridge keeps only these, and drops everything else on the floor
// (LOGIN_STORAGE_ROOT_DOMAINS in src/browser-login.ts). Rejecting them here
// instead means telling the operator why, rather than silently storing a
// session that cannot work.
const SESSION_COOKIE_DOMAINS = ["chatgpt.com", "openai.com"];

// Without this one there is no session at all; it is the cookie ChatGPT's own
// auth is carried in, and it is httpOnly — which is why `document.cookie` in
// the console is not enough and the value has to come from devtools or a
// cookie extension.
export const CHATGPT_WEB_REQUIRED_COOKIE = "__Secure-next-auth.session-token";

function onAllowedDomain(domain) {
  const host = String(domain || "").replace(/^\.+/, "").toLowerCase();
  return SESSION_COOKIE_DOMAINS.some((root) => host === root || host.endsWith(`.${root}`));
}

function normalizeCookie(raw) {
  const name = String(raw?.name ?? "").trim();
  const value = String(raw?.value ?? "");
  if (!name || !value) return null;
  const domain = String(raw?.domain || "").trim() || ".chatgpt.com";
  if (!onAllowedDomain(domain)) return null;
  // Playwright rejects a storage state whose sameSite is not one of these, and
  // browser extensions export several other spellings.
  const sameSiteRaw = String(raw?.sameSite ?? "").toLowerCase();
  const sameSite = sameSiteRaw.startsWith("l") ? "Lax"
    : sameSiteRaw.startsWith("s") ? "Strict"
      : sameSiteRaw.startsWith("n") ? "None"
        : "Lax";
  const expires = Number(raw?.expires ?? raw?.expirationDate ?? -1);
  return {
    name,
    value,
    domain,
    path: String(raw?.path || "/"),
    expires: Number.isFinite(expires) && expires > 0 ? Math.floor(expires) : -1,
    httpOnly: Boolean(raw?.httpOnly),
    secure: raw?.secure === undefined ? true : Boolean(raw.secure),
    sameSite,
  };
}

/**
 * Turn whatever the operator pasted into a Playwright storage state.
 *
 * Four shapes are accepted because there are four plausible ways to get this
 * out of a browser, and guessing wrong is a frustrating way to fail:
 *   - a full storage state, `{cookies, origins}`, from Playwright itself;
 *   - a cookie array, which is what Cookie-Editor and EditThisCookie export;
 *   - a `name=value; name=value` string, as `document.cookie` produces;
 *   - the bare session-token value, copied out of devtools.
 *
 * @returns {{cookies: object[], origins: object[]}}
 * @throws {Error} when nothing usable, or no session cookie, is present
 */
export function parseChatGptWebSession(input) {
  const text = typeof input === "string" ? input.trim() : "";
  let cookies = [];
  let origins = [];

  if (Array.isArray(input)) {
    cookies = input;
  } else if (input && typeof input === "object") {
    cookies = Array.isArray(input.cookies) ? input.cookies : [];
    origins = Array.isArray(input.origins) ? input.origins : [];
  } else if (text.startsWith("{") || text.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`That looks like JSON but does not parse: ${e.message}`);
    }
    return parseChatGptWebSession(parsed);
  } else if (text.includes("=")) {
    cookies = text.split(/;\s*/).map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 1) return null;
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
    }).filter(Boolean);
  } else if (text) {
    // A bare token: the only cookie that matters, pasted on its own.
    cookies = [{ name: CHATGPT_WEB_REQUIRED_COOKIE, value: text, httpOnly: true }];
  }

  const normalized = cookies.map(normalizeCookie).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error(
      "No usable chatgpt.com cookies found. Paste the value of "
      + `${CHATGPT_WEB_REQUIRED_COOKIE}, or a cookie export for chatgpt.com.`,
    );
  }
  if (!normalized.some((c) => c.name === CHATGPT_WEB_REQUIRED_COOKIE)) {
    throw new Error(
      `${CHATGPT_WEB_REQUIRED_COOKIE} is missing. It is httpOnly, so it does not appear in `
      + "document.cookie — copy it from devtools (Application → Cookies) or a cookie extension.",
    );
  }
  return {
    cookies: normalized,
    origins: origins.filter((o) => o?.origin === "https://chatgpt.com"),
  };
}

/**
 * The bridge's session endpoint — how 9Router signs it in.
 *
 * The bridge authenticates from a Playwright storage state on disk, and
 * producing one used to mean a human driving a browser inside that container,
 * which is why it carried Xvfb, x11vnc and noVNC. It does not have to: a
 * storage state is cookies, and cookies can be handed over. The dashboard
 * collects a chatgpt.com session, posts it here, and the bridge writes the
 * state and verifies it with its own browser. No remote desktop at any point.
 */
export const CHATGPT_WEB_SESSION_PORT = 17842;
export const CHATGPT_WEB_SESSION_PATH = "/session";

/**
 * Where that endpoint lives, derived from the bridge's own address so there is
 * one thing to configure rather than two.
 */
export function chatGptWebSessionUrl(env = process.env) {
  const { protocol, hostname } = new URL(assertBridgeBaseUrl(env.CHATGPT_WEB_BASE_URL));
  const port = Number(env.CHATGPT_WEB_SESSION_PORT || CHATGPT_WEB_SESSION_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid CHATGPT_WEB_SESSION_PORT: ${env.CHATGPT_WEB_SESSION_PORT}`);
  }
  return `${protocol}//${hostname}:${port}${CHATGPT_WEB_SESSION_PATH}`;
}
