// Quota auto-ping scheduler: warms 5h windows by sending tiny opt-in requests right after reset.
import "open-sse/index.js";

import { getSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { getClaudeUsage } from "open-sse/services/usage/claude.js";
import { getCodexUsage } from "open-sse/services/usage/codex.js";
import { getExecutor } from "open-sse/executors/index.js";
import { CLAUDE_CLI_SPOOF_HEADERS } from "open-sse/providers/shared.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { QUOTA_AUTOPING_CONFIG } from "@/shared/constants/config";
import { cronFireKey, firstMatchingExpression } from "@/shared/services/cronMatcher";

const C = QUOTA_AUTOPING_CONFIG;
const CLAUDE_PING_URL = "https://api.anthropic.com/v1/messages?beta=true";

const providerHandlers = {
  claude: {
    getUsage: getClaudeUsage,
    sendPing: sendClaudePing,
    // Ban-safe alternative: spawn the real Claude Code binary instead of
    // replaying the OAuth token from this server. Opt in per schedule.
    sendPingViaCli: sendClaudeCliPing,
  },
  codex: {
    getUsage: getCodexUsage,
    sendPing: sendCodexPing,
  },
  // Deliberately no getUsage: Claude Code exposes no non-interactive quota
  // endpoint, so there is no reactive mode here — only cron schedules. Both
  // send entries point at the CLI because spawning the binary is the only way
  // to reach this provider at all.
  "claude-cli": {
    sendPing: sendClaudeCliPing,
    sendPingViaCli: sendClaudeCliPing,
  },
};

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__quotaAutoPing ??= {
  interval: null,
  running: false,
  resetCache: {},
  failureCache: {},
});

function cacheKey(provider, connectionId) {
  return `${provider}:${connectionId}`;
}

function normalizeResetKey(resetAt) {
  const ms = new Date(resetAt).getTime();
  if (!Number.isFinite(ms)) return resetAt;
  return new Date(Math.floor(ms / 60000) * 60000).toISOString();
}

function getResetDriftMs(previousResetAt, nextResetAt) {
  const previousMs = new Date(previousResetAt).getTime();
  const nextMs = new Date(nextResetAt).getTime();
  if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs)) return 0;
  return nextMs - previousMs;
}

function toFiniteNumber(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isQuotaExhausted(quota) {
  if (!quota || quota.unlimited === true) return false;
  const remaining = toFiniteNumber(quota.remaining);
  if (remaining !== null) return remaining <= 0;

  const used = toFiniteNumber(quota.used);
  const total = toFiniteNumber(quota.total);
  return total !== null && total > 0 && used !== null && used >= total;
}

function wasPingedRecently(connection, intervalMs, nowMs = Date.now()) {
  if (!intervalMs) return false;
  const lastPingAtMs = new Date(connection.lastPingAt).getTime();
  return Number.isFinite(lastPingAtMs) && nowMs - lastPingAtMs < intervalMs;
}

function isBlockingQuotaName(name, sessionKey) {
  if (name === sessionKey) return false;
  return !String(name).toLowerCase().includes("session");
}

function hasExhaustedBlockingQuota(quotas, sessionKey) {
  return Object.entries(quotas || {}).some(([name, quota]) => isBlockingQuotaName(name, sessionKey) && isQuotaExhausted(quota));
}

function shouldPingForReset(providerConfig, cachedReset, resetAt, now) {
  if (providerConfig.pingWhenResetAtSlides) {
    return Boolean(cachedReset) && getResetDriftMs(cachedReset, resetAt) >= (providerConfig.resetAtDriftMs || 0);
  }

  const resetMs = new Date(resetAt).getTime();
  return Number.isFinite(resetMs) && now >= resetMs - C.pingLeadMs;
}

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

async function sendClaudePing(connection, providerConfig, proxyOptions, deps) {
  const res = await deps.proxyAwareFetch(CLAUDE_PING_URL, {
    method: "POST",
    headers: {
      ...CLAUDE_CLI_SPOOF_HEADERS,
      "Authorization": `Bearer ${connection.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: providerConfig.pingModel,
      max_tokens: providerConfig.pingMaxTokens,
      messages: [{ role: "user", content: providerConfig.pingText }],
    }),
  }, proxyOptions);
  return res.ok;
}

// Sends the keepalive through the local Claude Code binary (`claude -p`) so the
// request carries a real CLI session instead of an OAuth token replayed by this
// server. Returns false when the executor reports an error frame.
async function sendClaudeCliPing(connection, providerConfig, proxyOptions, deps) {
  const executor = deps.getExecutor("claude-cli");
  // Bounded: the scheduler runs one tick at a time, so an unbounded drain here
  // would stall every other provider's pings for as long as the child hangs.
  const timeout = AbortSignal.timeout(C.cliPingTimeoutMs);
  const { response } = await executor.execute({
    model: providerConfig.cliPingModel,
    body: { messages: [{ role: "user", content: providerConfig.pingText }] },
    // Pass the account through: the executor reads `configDir`/`oauthToken`
    // out of it to pick which Claude Code identity the child runs as. With an
    // empty object it fell back to whatever the host happened to be signed
    // into, so a per-account schedule pinged the wrong account. A `claude`
    // OAuth row carries neither key, so that path is unchanged.
    credentials: { providerSpecificData: connection?.providerSpecificData },
    signal: timeout,
    log: console,
  });
  if (!response.ok) {
    try { await response.body?.cancel?.(); } catch { /* noop */ }
    return false;
  }
  // The CLI turn only completes once the stream drains; a mid-stream failure
  // surfaces as an SSE error frame, so the body is inspected too.
  try {
    const body = await response.text();
    return !body.includes("claude_cli_error");
  } catch (e) {
    console.warn(`[AutoPing] claude-cli ping drain failed: ${e.message}`);
    return false;
  }
}

function buildCodexPingInput(text) {
  return [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  }];
}

async function drainResponseBody(response) {
  if (typeof response?.text === "function") {
    await response.text();
    return;
  }

  const reader = response?.body?.getReader?.();
  if (!reader) return;

  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock?.();
  }
}

async function sendCodexPing(connection, providerConfig, proxyOptions, deps) {
  const executor = deps.getExecutor("codex");
  const { response } = await executor.execute({
    model: providerConfig.pingModel,
    stream: true,
    credentials: {
      accessToken: connection.accessToken,
      connectionId: connection.id,
      providerSpecificData: connection.providerSpecificData,
    },
    proxyOptions,
    log: console,
    body: {
      model: providerConfig.pingModel,
      input: buildCodexPingInput(providerConfig.pingText),
      instructions: providerConfig.pingInstructions,
      reasoning: providerConfig.pingReasoningEffort
        ? { effort: providerConfig.pingReasoningEffort, summary: "auto" }
        : undefined,
      store: false,
      stream: true,
    },
  });
  if (!response.ok) {
    try { await response.body?.cancel?.(); } catch { /* noop */ }
    return false;
  }

  // Codex only starts the 5h window after the streaming response completes.
  await drainResponseBody(response);
  return true;
}

function shouldSkipAfterFailure(state, key, nowMs = Date.now(), cooldownMs = C.failureCooldownMs) {
  const failedAt = state.failureCache[key];
  return failedAt && nowMs - failedAt < cooldownMs;
}

// -- Cron schedules ---------------------------------------------------------
// settings[settingsKey].cron = { [connectionId]: { enabled, expressions[], timezone, text, via } }

export function readCronEntry(entry) {
  if (!entry || entry.enabled === false) return null;
  const expressions = (Array.isArray(entry.expressions) ? entry.expressions : [])
    .map((expression) => String(expression || "").trim())
    .filter(Boolean)
    .slice(0, C.cronMaxExpressions);
  if (expressions.length === 0) return null;
  return {
    expressions,
    timezone: entry.timezone || null,
    text: String(entry.text || "").trim() || C.cronPingText,
    via: entry.via === "cli" ? "cli" : "api",
  };
}

function hasCronSchedules(providerSettings) {
  return Object.values(providerSettings?.cron || {}).some((entry) => readCronEntry(entry) !== null);
}

export async function runCronPing(conn, provider, providerConfig, handler, cron, deps, state = g, now = new Date()) {
  const expression = firstMatchingExpression(cron.expressions, now, cron.timezone);
  if (!expression) return;

  const fireKey = cronFireKey(expression, now, cron.timezone);
  // Survives a restart inside the same minute - the key is persisted, not cached.
  if (conn.lastCronFireKey === fireKey) return;

  const key = `cron:${provider}:${conn.id}`;
  if (shouldSkipAfterFailure(state, key, now.getTime(), C.cronFailureCooldownMs)) return;

  const proxyCfg = await deps.resolveConnectionProxyConfig(conn.providerSpecificData);
  const proxyOptions = buildProxyOptions(proxyCfg);

  let connection = conn;
  // A local-credential provider holds its own session inside the binary, so
  // there is no token on this server to refresh. Attempting it would fail on
  // every tick and the schedule would never fire at all.
  if (!providerConfig.localCredentials) {
    try {
      const refreshed = await deps.refreshAndUpdateCredentials(connection, false, proxyOptions);
      connection = refreshed.connection;
    } catch (e) {
      state.failureCache[key] = Date.now();
      console.warn(`[AutoPing] cron ${provider}:${conn.id}: refresh failed: ${e.message}`);
      return;
    }
  }

  // A ping cannot reopen a window that is already spent - skip instead of
  // burning a request, but only when usage positively says so. A provider with
  // no usage endpoint (claude-cli) has nothing to ask, so it pings on schedule.
  if (typeof handler.getUsage === "function" && providerConfig.quotaKey) {
    try {
      const usage = await handler.getUsage(connection.accessToken, proxyOptions);
      const quota = usage?.quotas?.[providerConfig.quotaKey];
      if (isQuotaExhausted(quota)) {
        console.log(`[AutoPing] cron ${provider}:${connection.id}: skipped (quota exhausted)`);
        return;
      }
    } catch (e) {
      console.warn(`[AutoPing] cron ${provider}:${connection.id}: usage check failed, pinging anyway: ${e.message}`);
    }
  }

  const pingConfig = { ...providerConfig, pingText: cron.text };
  const useCli = cron.via === "cli" && typeof handler.sendPingViaCli === "function";
  const ok = useCli
    ? await handler.sendPingViaCli(connection, pingConfig, proxyOptions, deps)
    : await handler.sendPing(connection, pingConfig, proxyOptions, deps);
  // A local-credential provider reaches upstream through the binary whichever
  // branch ran, so reporting "api" for it would simply be false.
  const transport = useCli || providerConfig.localCredentials ? "cli" : "api";

  if (!ok) {
    state.failureCache[key] = Date.now();
    console.warn(`[AutoPing] cron ${provider}:${connection.id}: ping failed (${expression})`);
    return;
  }

  delete state.failureCache[key];
  await deps.updateProviderConnection(connection.id, {
    lastCronFireKey: fireKey,
    lastCronPingAt: new Date().toISOString(),
    lastPingAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  console.log(`[AutoPing] cron ${provider}:${connection.id}: ping sent via ${transport} (${expression})`);
}

async function pingConnection(conn, provider, providerConfig, handler, deps, state = g) {
  const key = cacheKey(provider, conn.id);

  // resetAt is stable for time-based windows; Codex polls every tick because inactive windows slide forward.
  const cachedReset = state.resetCache[key];
  if (!providerConfig.pingWhenResetAtSlides && cachedReset && Date.now() < new Date(cachedReset).getTime() - C.refreshAheadMs) return;

  // Avoid hammering provider auth/quota endpoints if a ping failed recently.
  if (shouldSkipAfterFailure(state, key)) return;

  const proxyCfg = await deps.resolveConnectionProxyConfig(conn.providerSpecificData);
  const proxyOptions = buildProxyOptions(proxyCfg);

  let connection = conn;
  try {
    const r = await deps.refreshAndUpdateCredentials(connection, false, proxyOptions);
    connection = r.connection;
  } catch (e) {
    state.failureCache[key] = Date.now();
    console.warn(`[AutoPing] ${provider}:${conn.id}: refresh failed: ${e.message}`);
    return;
  }

  const usage = await handler.getUsage(connection.accessToken, proxyOptions);
  const quotas = usage?.quotas || {};
  const quota = quotas?.[providerConfig.quotaKey];
  const resetAt = quota?.resetAt;
  if (!resetAt) return;

  state.resetCache[key] = resetAt;

  if (providerConfig.skipWhenBlockingQuotaExhausted && hasExhaustedBlockingQuota(quotas, providerConfig.quotaKey)) return;
  if (isQuotaExhausted(quota)) return;

  const now = Date.now();
  const resetKey = normalizeResetKey(resetAt);
  const lastPingedResetKey = connection.lastPingedResetKey || normalizeResetKey(connection.lastPingedResetAt);

  // Claude waits for reset. Codex pings only when resetAt slides, which means the 5h window is inactive.
  if (!shouldPingForReset(providerConfig, cachedReset, resetAt, now)) return;
  if (wasPingedRecently(connection, providerConfig.minPingIntervalMs, now)) return;
  if (lastPingedResetKey === resetKey) return;

  const ok = await handler.sendPing(connection, providerConfig, proxyOptions, deps);
  if (!ok) {
    // Do not mark reset as pinged unless upstream accepted the tiny request.
    state.failureCache[key] = Date.now();
    console.warn(`[AutoPing] ${provider}:${connection.id}: ping failed (reset ${resetAt})`);
    return;
  }

  delete state.failureCache[key];
  await deps.updateProviderConnection(connection.id, {
    lastPingedResetAt: resetAt,
    lastPingedResetKey: resetKey,
    lastPingAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  console.log(`[AutoPing] ${provider}:${connection.id}: ping sent (reset ${resetAt})`);
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    updateProviderConnection,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    proxyAwareFetch,
    getExecutor,
    // Injectable so a tick can be driven without touching real quota endpoints.
    providerHandlers,
  };
}

export async function runQuotaAutoPingTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    const settings = await deps.getSettings();

    for (const [provider, providerConfig] of Object.entries(C.providers)) {
      const handler = (deps.providerHandlers || providerHandlers)[provider];
      if (!handler) continue;

      const providerSettings = settings?.[providerConfig.settingsKey] || {};
      const enabledMap = providerSettings.connections || {};
      const cronMap = providerSettings.cron || {};
      if (Object.keys(enabledMap).length === 0 && !hasCronSchedules(providerSettings)) continue;

      const conns = await deps.getProviderConnections({ provider, isActive: true });
      for (const conn of conns) {
        // OAuth is the norm, but a local-credential provider stores its
        // accounts with authType "none" (the credential is a config directory
        // or a setup token, not a token this server holds), so this gate would
        // skip every one of them.
        if (conn.authType !== "oauth" && !providerConfig.localCredentials) continue;
        const cron = readCronEntry(cronMap[conn.id]);
        // Reactive mode needs a usage endpoint to read a reset time from.
        const resetPingEnabled = enabledMap[conn.id] === true
          && typeof handler.getUsage === "function";
        if (!cron && !resetPingEnabled) continue;

        try {
          if (cron) await runCronPing(conn, provider, providerConfig, handler, cron, deps, state);
          if (resetPingEnabled) await pingConnection(conn, provider, providerConfig, handler, deps, state);
        } catch (e) {
          state.failureCache[cacheKey(provider, conn.id)] = Date.now();
          console.warn(`[AutoPing] ${provider}:${conn.id}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.warn("[AutoPing] tick error:", e.message);
  } finally {
    state.running = false;
  }
}

export function startQuotaAutoPing() {
  if (g.interval) return;
  console.log("[AutoPing] scheduler started");
  runQuotaAutoPingTick().catch(() => {});
  g.interval = setInterval(() => { runQuotaAutoPingTick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopQuotaAutoPing() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[AutoPing] scheduler stopped");
}

export function configureQuotaAutoPing(settings) {
  const enabled = Object.values(C.providers).some((providerConfig) => {
    const providerSettings = settings?.[providerConfig.settingsKey];
    return Object.values(providerSettings?.connections || {}).some(Boolean)
      || hasCronSchedules(providerSettings);
  });
  if (enabled) startQuotaAutoPing();
  else stopQuotaAutoPing();
}
