import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseCronExpression,
  isValidCronExpression,
  cronMatches,
  cronFireKey,
  firstMatchingExpression,
  zonedParts,
} from "@/shared/services/cronMatcher";
import { readCronEntry, runCronPing, runQuotaAutoPingTick, configureQuotaAutoPing, stopQuotaAutoPing } from "@/shared/services/quotaAutoPing";
import { QUOTA_AUTOPING_CONFIG } from "@/shared/constants/config";

// 2026-09-21 is a Monday.
const at = (iso) => new Date(iso);

describe("cron expression parsing", () => {
  it("accepts the shapes the UI can produce", () => {
    for (const expression of ["* * * * *", "0 */5 * * *", "30 9 * * 1-5", "0 0,6,12,18 * * *", "15 3 1 jan mon", "@hourly"]) {
      expect(isValidCronExpression(expression)).toBe(true);
    }
  });

  it("rejects malformed expressions instead of matching everything", () => {
    for (const expression of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "a * * * *", "*/0 * * * *", "5-1 * * * *", null, undefined]) {
      expect(isValidCronExpression(expression)).toBe(false);
      expect(cronMatches(expression, at("2026-09-21T00:00:00Z"))).toBe(false);
    }
  });

  it("expands steps and ranges", () => {
    const cron = parseCronExpression("0 */6 * * *");
    expect([...cron.hour]).toEqual([0, 6, 12, 18]);
    expect([...cron.minute]).toEqual([0]);
  });

  it("treats day-of-week 7 as Sunday", () => {
    expect([...parseCronExpression("0 0 * * 7").dayOfWeek]).toEqual([0]);
  });
});

describe("cron matching", () => {
  it("matches on the exact minute only", () => {
    expect(cronMatches("30 9 * * *", at("2026-09-21T09:30:00Z"), "UTC")).toBe(true);
    expect(cronMatches("30 9 * * *", at("2026-09-21T09:31:00Z"), "UTC")).toBe(false);
    expect(cronMatches("30 9 * * *", at("2026-09-21T10:30:00Z"), "UTC")).toBe(false);
  });

  it("evaluates in the configured timezone, not the server's", () => {
    // 00:00 UTC is 09:00 in Seoul (UTC+9).
    expect(cronMatches("0 9 * * *", at("2026-09-21T00:00:00Z"), "Asia/Seoul")).toBe(true);
    expect(cronMatches("0 9 * * *", at("2026-09-21T00:00:00Z"), "UTC")).toBe(false);
  });

  it("falls back to local time for an invalid timezone", () => {
    expect(() => zonedParts(at("2026-09-21T00:00:00Z"), "Not/AZone")).not.toThrow();
  });

  it("ORs day-of-month with day-of-week when both are restricted", () => {
    // 2026-09-21 is a Monday and the 21st.
    expect(cronMatches("0 0 21 * 5", at("2026-09-21T00:00:00Z"), "UTC")).toBe(true); // dom hits
    expect(cronMatches("0 0 1 * 1", at("2026-09-21T00:00:00Z"), "UTC")).toBe(true);  // dow hits
    expect(cronMatches("0 0 1 * 5", at("2026-09-21T00:00:00Z"), "UTC")).toBe(false); // neither
  });

  it("picks the first matching expression of a list", () => {
    const expressions = ["0 3 * * *", "0 9 * * *", "0 15 * * *"];
    expect(firstMatchingExpression(expressions, at("2026-09-21T09:00:00Z"), "UTC")).toBe("0 9 * * *");
    expect(firstMatchingExpression(expressions, at("2026-09-21T10:00:00Z"), "UTC")).toBe(null);
  });

  it("produces a stable per-minute fire key", () => {
    const a = cronFireKey("0 9 * * *", at("2026-09-21T09:00:00Z"), "UTC");
    const b = cronFireKey("0 9 * * *", at("2026-09-21T09:00:59Z"), "UTC");
    const next = cronFireKey("0 9 * * *", at("2026-09-22T09:00:00Z"), "UTC");
    expect(a).toBe(b);
    expect(a).not.toBe(next);
  });
});

describe("readCronEntry", () => {
  it("returns null unless the entry is usable", () => {
    expect(readCronEntry(undefined)).toBe(null);
    expect(readCronEntry({ enabled: false, expressions: ["0 * * * *"] })).toBe(null);
    expect(readCronEntry({ expressions: [] })).toBe(null);
    expect(readCronEntry({ expressions: ["  "] })).toBe(null);
  });

  it("defaults the ping text and api transport", () => {
    const entry = readCronEntry({ expressions: ["0 */5 * * *"] });
    expect(entry.text).toBe(QUOTA_AUTOPING_CONFIG.cronPingText);
    expect(entry.via).toBe("api");
  });

  it("keeps an explicit text, timezone and cli transport", () => {
    const entry = readCronEntry({ expressions: ["0 9 * * *"], text: "Only Hi", timezone: "Asia/Seoul", via: "cli" });
    expect(entry).toMatchObject({ text: "Only Hi", timezone: "Asia/Seoul", via: "cli" });
  });

  it("caps the number of expressions", () => {
    const many = Array.from({ length: 50 }, (_, i) => `${i % 60} * * * *`);
    expect(readCronEntry({ expressions: many }).expressions).toHaveLength(QUOTA_AUTOPING_CONFIG.cronMaxExpressions);
  });
});

function harness(overrides = {}) {
  const connection = { id: "conn-1", accessToken: "tok", providerSpecificData: {}, ...overrides.connection };
  const deps = {
    resolveConnectionProxyConfig: vi.fn(async () => ({})),
    refreshAndUpdateCredentials: vi.fn(async (conn) => ({ connection: conn })),
    updateProviderConnection: vi.fn(async () => {}),
    getExecutor: vi.fn(),
  };
  const handler = {
    getUsage: vi.fn(async () => ({ quotas: { "session (5h)": { remaining: 100 } } })),
    sendPing: vi.fn(async () => true),
    sendPingViaCli: vi.fn(async () => true),
    ...overrides.handler,
  };
  const state = { resetCache: {}, failureCache: {}, running: false };
  return { connection, deps, handler, state, providerConfig: QUOTA_AUTOPING_CONFIG.providers.claude };
}

describe("runCronPing", () => {
  const cron = { expressions: ["0 9 * * *"], timezone: "UTC", text: "Only Hi", via: "api" };

  it("does nothing when no expression matches the current minute", async () => {
    const h = harness();
    await runCronPing(h.connection, "claude", h.providerConfig, h.handler, cron, h.deps, h.state, at("2026-09-21T10:00:00Z"));
    expect(h.handler.sendPing).not.toHaveBeenCalled();
  });

  it("sends the configured text and records the fire key", async () => {
    const h = harness();
    await runCronPing(h.connection, "claude", h.providerConfig, h.handler, cron, h.deps, h.state, at("2026-09-21T09:00:00Z"));
    expect(h.handler.sendPing).toHaveBeenCalledTimes(1);
    expect(h.handler.sendPing.mock.calls[0][1].pingText).toBe("Only Hi");
    const update = h.deps.updateProviderConnection.mock.calls[0][1];
    expect(update.lastCronFireKey).toBe(cronFireKey("0 9 * * *", at("2026-09-21T09:00:00Z"), "UTC"));
    expect(update.lastPingAt).toBeTruthy();
  });

  it("does not re-fire within the same minute after a restart", async () => {
    const fireKey = cronFireKey("0 9 * * *", at("2026-09-21T09:00:00Z"), "UTC");
    const h = harness({ connection: { lastCronFireKey: fireKey } });
    await runCronPing(h.connection, "claude", h.providerConfig, h.handler, cron, h.deps, h.state, at("2026-09-21T09:00:30Z"));
    expect(h.handler.sendPing).not.toHaveBeenCalled();
  });

  it("skips when the quota is already exhausted", async () => {
    const h = harness({ handler: { getUsage: vi.fn(async () => ({ quotas: { "session (5h)": { remaining: 0 } } })) } });
    await runCronPing(h.connection, "claude", h.providerConfig, h.handler, cron, h.deps, h.state, at("2026-09-21T09:00:00Z"));
    expect(h.handler.sendPing).not.toHaveBeenCalled();
    expect(h.deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("still pings when the usage probe itself fails", async () => {
    const h = harness({ handler: { getUsage: vi.fn(async () => { throw new Error("usage down"); }) } });
    await runCronPing(h.connection, "claude", h.providerConfig, h.handler, cron, h.deps, h.state, at("2026-09-21T09:00:00Z"));
    expect(h.handler.sendPing).toHaveBeenCalledTimes(1);
  });

  it("routes through the CLI when the schedule opts in", async () => {
    const h = harness();
    await runCronPing(h.connection, "claude", h.providerConfig, h.handler, { ...cron, via: "cli" }, h.deps, h.state, at("2026-09-21T09:00:00Z"));
    expect(h.handler.sendPingViaCli).toHaveBeenCalledTimes(1);
    expect(h.handler.sendPing).not.toHaveBeenCalled();
  });

  it("records a failure and does not mark the minute as fired", async () => {
    const h = harness({ handler: { sendPing: vi.fn(async () => false) } });
    await runCronPing(h.connection, "claude", h.providerConfig, h.handler, cron, h.deps, h.state, at("2026-09-21T09:00:00Z"));
    expect(h.deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(h.state.failureCache["cron:claude:conn-1"]).toBeTruthy();
  });

  it("does not ping while a recent failure is still cooling down", async () => {
    const h = harness();
    h.state.failureCache["cron:claude:conn-1"] = at("2026-09-21T09:00:00Z").getTime();
    await runCronPing(h.connection, "claude", h.providerConfig, h.handler, cron, h.deps, h.state, at("2026-09-21T09:00:00Z"));
    expect(h.handler.sendPing).not.toHaveBeenCalled();
  });

  it("aborts when the credential refresh fails", async () => {
    const h = harness();
    h.deps.refreshAndUpdateCredentials = vi.fn(async () => { throw new Error("refresh failed"); });
    await runCronPing(h.connection, "claude", h.providerConfig, h.handler, cron, h.deps, h.state, at("2026-09-21T09:00:00Z"));
    expect(h.handler.sendPing).not.toHaveBeenCalled();
    expect(h.state.failureCache["cron:claude:conn-1"]).toBeTruthy();
  });
});

function tickHarness({ settings, connections, handler = {} }) {
  const sendPing = vi.fn(async () => true);
  const deps = {
    getSettings: vi.fn(async () => settings),
    getProviderConnections: vi.fn(async () => connections),
    updateProviderConnection: vi.fn(async () => {}),
    resolveConnectionProxyConfig: vi.fn(async () => ({})),
    refreshAndUpdateCredentials: vi.fn(async (conn) => ({ connection: conn })),
    proxyAwareFetch: vi.fn(),
    getExecutor: vi.fn(),
    providerHandlers: {
      claude: {
        getUsage: vi.fn(async () => ({ quotas: { "session (5h)": { remaining: 100, resetAt: new Date(Date.now() + 3600000).toISOString() } } })),
        sendPing,
        ...handler,
      },
    },
  };
  return { deps, sendPing, state: { resetCache: {}, failureCache: {}, running: false } };
}

const oauthConn = (overrides = {}) => ({
  id: "conn-1",
  authType: "oauth",
  accessToken: "tok",
  providerSpecificData: {},
  ...overrides,
});

describe("runQuotaAutoPingTick with cron schedules", () => {
  // "* * * * *" matches whatever minute the test runs in.
  const everyMinute = { enabled: true, expressions: ["* * * * *"], timezone: "UTC", text: "Only Hi" };

  it("pings a cron-only connection even when the reset-based toggle is off", async () => {
    const h = tickHarness({
      settings: { claudeAutoPing: { connections: {}, cron: { "conn-1": everyMinute } } },
      connections: [oauthConn()],
    });
    await runQuotaAutoPingTick(h.deps, h.state);
    expect(h.sendPing).toHaveBeenCalledTimes(1);
    expect(h.sendPing.mock.calls[0][1].pingText).toBe("Only Hi");
  });

  it("ignores a disabled schedule", async () => {
    const h = tickHarness({
      settings: { claudeAutoPing: { connections: {}, cron: { "conn-1": { ...everyMinute, enabled: false } } } },
      connections: [oauthConn()],
    });
    await runQuotaAutoPingTick(h.deps, h.state);
    expect(h.sendPing).not.toHaveBeenCalled();
    expect(h.deps.getProviderConnections).not.toHaveBeenCalled();
  });

  it("does not ping a connection that has no schedule of its own", async () => {
    const h = tickHarness({
      settings: { claudeAutoPing: { connections: {}, cron: { "other-conn": everyMinute } } },
      connections: [oauthConn()],
    });
    await runQuotaAutoPingTick(h.deps, h.state);
    expect(h.sendPing).not.toHaveBeenCalled();
  });

  it("skips non-oauth connections", async () => {
    const h = tickHarness({
      settings: { claudeAutoPing: { connections: {}, cron: { "conn-1": everyMinute } } },
      connections: [oauthConn({ authType: "apikey" })],
    });
    await runQuotaAutoPingTick(h.deps, h.state);
    expect(h.sendPing).not.toHaveBeenCalled();
  });

  it("keeps a failing connection from aborting the rest of the tick", async () => {
    const h = tickHarness({
      settings: { claudeAutoPing: { connections: {}, cron: { "conn-1": everyMinute, "conn-2": everyMinute } } },
      connections: [oauthConn(), oauthConn({ id: "conn-2" })],
    });
    h.deps.resolveConnectionProxyConfig = vi.fn(async (data) => {
      if (data?.boom) throw new Error("proxy config exploded");
      return {};
    });
    h.deps.getProviderConnections = vi.fn(async () => [
      oauthConn({ providerSpecificData: { boom: true } }),
      oauthConn({ id: "conn-2" }),
    ]);
    await runQuotaAutoPingTick(h.deps, h.state);
    expect(h.sendPing).toHaveBeenCalledTimes(1);
  });
});

describe("configureQuotaAutoPing", () => {
  afterEach(() => stopQuotaAutoPing());

  it("starts the scheduler for a cron-only configuration", () => {
    configureQuotaAutoPing({ claudeAutoPing: { connections: {}, cron: { "conn-1": { expressions: ["0 9 * * *"] } } } });
    expect(global.__quotaAutoPing.interval).toBeTruthy();
  });

  it("stays stopped when nothing is configured", () => {
    configureQuotaAutoPing({ claudeAutoPing: { connections: {}, cron: {} } });
    expect(global.__quotaAutoPing.interval).toBeFalsy();
  });
});
