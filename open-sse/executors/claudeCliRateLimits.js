/**
 * Subscription windows, as the CLI itself reports them.
 *
 * The OAuth usage endpoint is not available to every account. A credential from
 * `claude setup-token` — the only kind that works in a container, where there is
 * no terminal to sign in with — is refused by it:
 *
 *   403 OAuth token does not meet scope requirement user:profile
 *
 * So those accounts had no quota to show at all. But the CLI emits the same
 * numbers on every routed request, in a `rate_limit_event`:
 *
 *   rate_limit_info.unifiedWindows = {
 *     five_hour: { utilization: 0.28, resetsAt: 1790157000 },
 *     seven_day: { utilization: 0.49, resetsAt: 1790319600 },
 *   }
 *
 * — a fraction rather than a percentage, and unix seconds rather than an ISO
 * string, but the same two windows the card draws. Recording them as they go
 * past costs nothing and works for every account, whatever its credential.
 *
 * Held in memory, per server process: the figures belong to a subscription and
 * are stale the moment anything else uses it, so re-reading them from the next
 * request is the point. An account that has routed nothing since the server
 * started has none, and falls back to what this server counted.
 */
import crypto from "node:crypto";

// Survives Next's module re-evaluation the way the rest of the codebase does.
const store = (globalThis.__claudeCliRateLimits ??= new Map());

/**
 * A stable key for an account that never contains the credential itself.
 * A config directory is already a path; a token is reduced to a digest, so
 * nothing here is worth stealing.
 */
export function rateLimitAccountKey(psd = {}) {
  // Token first, because that is the order the spawn resolves them in: a
  // CLAUDE_CODE_OAUTH_TOKEN overrides whatever the config directory has stored,
  // so it names the subscription the request actually ran against. Keying on
  // the directory instead filed an account's usage under an identity it was
  // not using.
  if (psd?.oauthToken) {
    return `tok:${crypto.createHash("sha256").update(String(psd.oauthToken)).digest("hex").slice(0, 16)}`;
  }
  if (psd?.configDir) return `dir:${psd.configDir}`;
  return "";
}

/** Record what a routed request was told about the subscription's windows. */
export function recordRateLimitEvent(psd, rateLimitInfo) {
  const key = rateLimitAccountKey(psd);
  const windows = rateLimitInfo?.unifiedWindows;
  if (!key || !windows || typeof windows !== "object") return;
  store.set(key, { windows, at: Date.now() });
}

/** The last windows seen for this account, or null. */
export function rateLimitWindows(psd) {
  const key = rateLimitAccountKey(psd);
  if (!key) return null;
  return store.get(key) || null;
}

/** Only for tests: forget everything recorded so far. */
export function resetRateLimitWindows() {
  store.clear();
}

const WINDOW_NAMES = {
  five_hour: "session (5h)",
  seven_day: "weekly (7d)",
};

function toQuota(window) {
  const utilization = Number(window?.utilization);
  if (!Number.isFinite(utilization)) return null;
  // Reported as a fraction of the window, unlike the usage endpoint's percent.
  const used = Math.max(0, Math.min(100, Math.round(utilization * 100)));
  const resetsAt = Number(window?.resetsAt);
  return {
    used,
    total: 100,
    remaining: 100 - used,
    remainingPercentage: 100 - used,
    // Unix seconds from the CLI; the card wants something Date can parse.
    resetAt: Number.isFinite(resetsAt) && resetsAt > 0
      ? new Date(resetsAt * 1000).toISOString()
      : null,
    unlimited: false,
  };
}

/**
 * The recorded windows in the shape the dashboard renders, under the same names
 * the `claude` provider uses — so one card draws both without knowing which
 * source it got.
 *
 * @returns {object|null} null when nothing usable was recorded
 */
export function windowsToQuotas(windows) {
  if (!windows || typeof windows !== "object") return null;
  const quotas = {};
  for (const [key, name] of Object.entries(WINDOW_NAMES)) {
    const quota = toQuota(windows[key]);
    if (quota) quotas[name] = quota;
  }
  return Object.keys(quotas).length ? quotas : null;
}
