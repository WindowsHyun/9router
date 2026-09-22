/**
 * Usage figures for providers that report no quota of their own.
 *
 * Claude Code CLI and ChatGPT Web both bill against a subscription this server
 * cannot query. `claude -p --output-format json` returns the cost and tokens of
 * *that call* (usage.input_tokens, output_tokens, total_cost_usd) but no window
 * remaining and no reset time; the ChatGPT Web bridge exposes no usage endpoint
 * at all, and its executor sees no rate-limit headers.
 *
 * So there is nothing upstream to show a percentage of. What this server does
 * know is what it routed itself, which is already recorded per connection in
 * usageHistory. That is what these figures are — and every quota returned here
 * is flagged `unlimited: true` (so no progress bar is drawn against a limit
 * that was never reported) and named to say where the number came from, rather
 * than being dressed up as a quota.
 */
import { getAdapter } from "@/lib/db/driver.js";

const WINDOWS = [
  { label: "routed 5h", hours: 5 },
  { label: "routed 24h", hours: 24 },
  { label: "routed 7d", hours: 24 * 7 },
];

function sinceIso(hours) {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function sumTokens(rows) {
  let tokens = 0;
  for (const row of rows) {
    try {
      const parsed = typeof row.tokens === "string" ? JSON.parse(row.tokens) : (row.tokens || {});
      tokens += Number(parsed?.total)
        || (Number(parsed?.prompt_tokens) || 0) + (Number(parsed?.completion_tokens) || 0);
    } catch { /* a malformed row should not lose the rest of the window */ }
  }
  return tokens;
}

/**
 * @param {{ id: string, provider: string }} connection
 * @returns {Promise<{ quotas: object, message?: string, source: string }>}
 */
export async function getRoutedUsage(connection) {
  const db = await getAdapter();
  const quotas = {};

  for (const { label, hours } of WINDOWS) {
    const rows = db.all(
      "SELECT cost, tokens, status FROM usageHistory WHERE connectionId = ? AND timestamp >= ?",
      [connection.id, sinceIso(hours)],
    );
    const failed = rows.filter((r) => r.status && r.status !== "success" && r.status !== "ok").length;
    const cost = rows.reduce((sum, r) => sum + (Number(r.cost) || 0), 0);

    quotas[`${label} · requests`] = {
      used: rows.length,
      // No upstream limit was reported, so there is no remaining to draw.
      unlimited: true,
      remaining: null,
      remainingPercentage: null,
      resetAt: null,
      detail: failed ? `${rows.length} requests, ${failed} failed` : `${rows.length} requests`,
    };
    quotas[`${label} · tokens`] = {
      used: sumTokens(rows),
      unlimited: true,
      remaining: null,
      remainingPercentage: null,
      resetAt: null,
      detail: cost > 0 ? `≈ $${cost.toFixed(4)} at list price` : undefined,
    };
  }

  return {
    quotas,
    source: "9router",
    // Shown in the card so nobody reads these as subscription limits.
    message: "Counted by 9Router from what it routed — this provider reports no "
      + "quota, so remaining and reset are unknown.",
  };
}

export default getRoutedUsage;
