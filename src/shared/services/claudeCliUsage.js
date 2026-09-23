/**
 * Quota for the Claude Code CLI provider.
 *
 * claude-cli appears in USAGE_ROUTED_PROVIDERS because its connections carry
 * authType "none" — the credential is local rather than held by this server.
 * That is a statement about auth, not about quota. The account behind it is an
 * ordinary Claude subscription, and the OAuth usage endpoint the `claude`
 * provider already reads answers for it: the same `five_hour` / `seven_day`
 * windows, the same `utilization` and `resets_at`.
 *
 * Reading it here is what gives the card a percentage, a progress bar and a
 * reset countdown like every other provider, instead of bare counters. It also
 * means the figures are the subscription's real remaining capacity rather than
 * this server's own tally.
 *
 * Counting what this server routed (routedUsage) stays as the fallback, for an
 * account with no usable credential to ask with — a config-directory account
 * whose token has expired, or one whose login never completed.
 */
import { getClaudeUsage } from "open-sse/services/usage/claude.js";
import { claudeCliAccessToken } from "@/shared/services/claudeCliAccountRepair";
import { getRoutedUsage } from "@/shared/services/routedUsage";

/**
 * @param {{ id: string, provider: string, providerSpecificData?: object }} connection
 * @param {object|null} proxyOptions
 * @param {{ force?: boolean }} [options] force bypasses the 5-minute usage cache
 * @returns {Promise<object>} the same payload shape the `claude` provider returns
 */
export async function getClaudeCliUsage(connection, proxyOptions = null, options = {}) {
  const token = await claudeCliAccessToken(connection?.providerSpecificData || {});

  if (token) {
    // getClaudeUsage never throws: a 429, a network failure or an expired
    // credential all come back as { message }. Only a reading with windows in
    // it is worth showing — returning the soft failure would replace real
    // figures with an error string on a card that had been working.
    const usage = await getClaudeUsage(token, proxyOptions, { force: options?.force === true });
    if (usage?.quotas && Object.keys(usage.quotas).length > 0) return usage;
  }

  return getRoutedUsage(connection);
}

export default getClaudeCliUsage;
