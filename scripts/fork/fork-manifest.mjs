/**
 * Single source of truth for what this fork adds on top of upstream
 * (decolua/9router). Every fork script reads this; keep it in step with the
 * code and the upgrade tooling stays honest.
 *
 * See UPGRADE.md for how it is used.
 */

/** Upstream this fork tracks. */
export const UPSTREAM = {
  remote: "upstream",
  url: "https://github.com/decolua/9router",
  branch: "master",
};

/** Branch that carries the fork's commits. */
export const FORK_BRANCH = "master";

/**
 * Files this fork adds. Upstream never touches them, so they cannot conflict —
 * they only need to still be present after an upgrade.
 */
export const ADDED_FILES = [
  // claude-cli provider
  "open-sse/config/claudeCli.js",
  "open-sse/executors/claude-cli.js",
  "open-sse/providers/registry/claude-cli.js",
  "src/app/api/cli-tools/claude-cli-settings/route.js",
  "src/shared/components/ClaudeCliStatusCard.js",
  // cron auto-ping
  "src/shared/services/cronMatcher.js",
  "src/shared/components/AutoPingScheduleModal.js",
  // shared
  "open-sse/utils/concurrencyGate.js",
  // agent skills — third-party SKILL.md injected into routed requests
  "open-sse/skills/agentSkills.js",
  "src/lib/skills/fetchSkill.js",
  "src/lib/db/repos/agentSkillsRepo.js",
  "src/lib/db/migrations/002-agent-skills.js",
  "src/app/api/skills/route.js",
  "src/app/api/skills/[id]/route.js",
  "src/shared/components/AgentSkillsCard.js",
  // local-provider accounts and their Docker packaging
  "src/app/api/cli-tools/claude-cli-accounts/route.js",
  "src/shared/components/ClaudeCliAccountsCard.js",
  // tests — their absence means the fork is present but unproven
  "tests/unit/claude-cli-executor.test.js",
  "tests/unit/concurrency-gate.test.js",
  "tests/unit/quota-autoping-cron.test.js",
  "tests/unit/forced-sse-client-format.test.js",
  "tests/unit/agent-skills.test.js",
  "tests/real/claude-cli.real.test.js",
  // docs + tooling
  "AGENT-HANDOFF.md",
  "FORK-CHANGELOG.md",
  "UPGRADE.md",
  "scripts/fork/fork-manifest.mjs",
  "scripts/fork/verify-fork.mjs",
  "scripts/fork/upgrade-fork.mjs",
  "scripts/fork/export-patch.mjs",
  // reproduces the Local-only failure both cards showed, and the fix
  "scripts/fork/check-container-guard.mjs",
  // drives the Claude Code accounts route on a real server
  "scripts/fork/check-claude-accounts.mjs",
  // validates a Kubernetes bundle against the traps in AGENT-HANDOFF.md
  "scripts/fork/check-k8s-manifests.mjs",
];

/** Artwork the fork reuses from upstream files; regenerated rather than carried. */
export const DERIVED_ASSETS = [
  { from: "public/providers/claude.png", to: "public/providers/claude-cli.png" },
];

/**
 * Upstream files the fork edits. `markers` are strings that must be present for
 * the integration to be live — they are what verify-fork checks, and what a
 * conflict resolution has to preserve. `hint` is shown when a marker is missing
 * and when resolving a merge conflict in that file.
 */
export const PATCHED_FILES = [
  {
    path: "open-sse/executors/index.js",
    markers: ["ClaudeCliExecutor", '"claude-cli":'],
  },
  {
    path: "open-sse/providers/registry/index.js",
    markers: ["./claude-cli.js"],
    hint: "Despite the 'Auto-generated' header there is no generator script — this file is hand-maintained. On conflict take upstream's list, then re-add the fork import and its entry in the default-export array (use a free pN index — a duplicate pN is silent at merge time and stops the registry loading at boot).",
  },
  {
    path: "open-sse/handlers/chatCore/sseToJsonHandler.js",
    markers: ["translateNonStreamingResponse"],
    hint: "Fork replaces the final `const finalBody = ...` ternary with an if/else that also converts for non-OpenAI clients. Keep the fork branch; upstream's version is the block it replaced. This fix is a candidate to send upstream.",
  },
  {
    path: "src/shared/services/quotaAutoPing.js",
    markers: ["cronMatcher", "runCronPing", "readCronEntry", "sendClaudeCliPing", "providerHandlers"],
    hint: "Largest fork edit. Cron support is additive: the import, sendPingViaCli on the claude handler, sendClaudeCliPing, the cron block, the tick's cron branch, and the deps.providerHandlers injection. Keep all of them plus upstream's changes to the reset-based path.",
  },
  {
    path: "src/shared/constants/config.js",
    markers: ["cronPingText", "cronMaxExpressions", "cliPingModel", "cliPingTimeoutMs"],
    hint: "Additive keys inside QUOTA_AUTOPING_CONFIG. Keep them and any new upstream keys.",
  },
  {
    path: "src/shared/services/initializeApp.js",
    markers: ["config?.cron"],
    hint: "hasQuotaAutoPingEnabled must also return true for cron-only setups, or a cron schedule does not survive a restart.",
  },
  {
    path: "src/dashboardGuard.js",
    markers: ["/api/cli-tools/claude-cli-settings"],
    hint: "Both entries belong in LOCAL_ONLY_PATHS — one spawns a process, the other fetches a URL and can open a window on the host. Dropping them exposes those routes when requireLogin is false.",
  },
  {
    path: "src/app/api/cli-tools/all-statuses/route.js",
    markers: ["claudeCliGet"],
    hint: "Two imports and two STATUS_GETTERS entries.",
  },
  {
    path: "src/shared/constants/cliTools.js",
    markers: ['"claude-cli":'],
    hint: "Two CLI_TOOLS entries inserted before the `devin:` entry.",
  },
  {
    path: "src/shared/components/index.js",
    markers: ["AutoPingScheduleModal", "ClaudeCliStatusCard", "AgentSkillsCard", "ClaudeCliAccountsCard"],
    hint: "Five re-exports.",
  },
  {
    path: "src/sse/services/auth.js",
    markers: ["noAuthRows"],
  },
  {
    path: "src/dashboardGuard.js",
    markers: ["IS_CONTAINER", "NINEROUTER_HOST_ROUTES_REMOTE"],
    hint: "LOCAL_ONLY_PATHS requires a loopback request, which no container deployment can satisfy - both provider cards showed only \"Local only: CLI token required\". The gate is container-aware: authentication alone when containerised, the desktop rule everywhere else. Do not drop this or the Docker/K8s deployment loses those routes entirely.",
  },
  {
    path: "src/shared/constants/providers.js",
    markers: ["localSetup", "supportsAccounts"],
    hint: "The registry-to-UI field mapping is an explicit allowlist, so a new provider field is dropped unless it is listed here too.",
  },
  {
    path: "src/app/(dashboard)/dashboard/providers/page.js",
    markers: ["!provider.localSetup"],
    hint: "Upstream shows a green Ready badge for every noAuth provider. noAuth means no API key, not usable - a provider that needs a signed-in CLI or a running bridge must fall through to the real connection count.",
  },
  {
    path: "custom-server.js",
    markers: ['server.on("upgrade"'],
    hint: "The server.on(\"upgrade\") registration is load-bearing: Node only emits that event when a listener exists, so without it the h2c downgrade in the emit override never runs.",
  },
  {
    path: "Dockerfile",
    markers: ["claude-code", "CLI_CLAUDE_BIN"],
    hint: "Bundles a pinned @anthropic-ai/claude-code so the claude-cli provider works in the image with nothing else installed, and sets CLI_CLAUDE_BIN and CLAUDE_CONFIG_DIR. (The apk/npm mirror build args are NOT on this branch - they were part of the security work that was dropped.)",
  },
  {
    path: "docker-compose.yml",
    markers: ["9router"],
    hint: "Runs 9Router with the Claude Code CLI available inside the container.",
  },
  {
    path: "DOCKER.md",
    markers: ["claude setup-token"],
    hint: "Documents how the Claude Code CLI provider is signed in, with a setup token.",
  },
  {
    path: "src/lib/db/schema.js",
    markers: ["agentSkills:"],
    hint: "The agentSkills table definition. A fresh database gets every table from here via migration 001; an existing one gets this table from migration 002.",
  },
  {
    path: "src/lib/db/migrations/index.js",
    markers: ["002-agent-skills.js", "m002"],
    hint: "Register the migration. If upstream adds its own migration, renumber the fork's to keep versions unique and monotonically increasing — the registry sorts by version.",
  },
  {
    path: "src/lib/db/index.js",
    markers: ["agentSkillsRepo.js"],
    hint: "Re-export the repo.",
  },
  {
    path: "src/lib/localDb.js",
    markers: ["getEnabledAgentSkills"],
    hint: "The compat shim lists exports explicitly, so a new repo function must be added here too or every import through @/lib/localDb fails at build time.",
  },
  {
    path: "src/models/index.js",
    markers: ["getEnabledAgentSkills"],
    hint: "Same list again, one layer up.",
  },
  {
    path: "open-sse/handlers/chatCore.js",
    markers: ["injectAgentSkills", "agentSkills"],
    hint: "Takes `agentSkills` in the options object and injects them after the caveman/ponytail block, just before dispatch. Deliberately NOT gated on tokenSaverEnabled: a skill changes how the model answers and costs tokens rather than saving them.",
  },
  {
    path: "src/sse/handlers/chat.js",
    markers: ["getEnabledAgentSkills"],
    hint: "Loads the enabled skills per request (a local SQLite read, not a network fetch) and passes them to handleChatCore. The .catch(() => []) is deliberate — a skill must never be the reason a completion fails.",
  },
  {
    path: "src/app/(dashboard)/dashboard/skills/page.js",
    markers: ["AgentSkillsCard"],
    hint: "Mounts the Agent Skills card above upstream's static list of 9Router documentation links. Both live under the existing Skills menu.",
  },
  {
    path: "src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js",
    markers: ["autoPingSchedule", "scheduleTooltip"],
    hint: "Adds the autoPingSchedule prop, its Schedule button next to Auto-ping, the tooltip, and the propTypes entry.",
  },
  {
    path: "src/app/(dashboard)/dashboard/providers/[id]/page.js",
    markers: [
      "AutoPingScheduleModal",
      "ClaudeCliStatusCard",
      "cronScheduleTarget",
      "handleAutoPingSchedule",
    ],
    hint: "Imports, the cronScheduleTarget state, cron in the autoPing state + settings load, handleAutoPingSchedule, the autoPingSchedule prop on ConnectionRow, the modal near the other modals, and the two status cards in the isFreeNoAuth branch.",
  },
];

/**
 * Regenerated after every upgrade rather than merged: upstream adds providers of
 * its own, so these snapshots conflict on release and are cheap to rebuild.
 */
export const REGENERATED_BASELINES = [
  { file: "tests/__baseline__/providers-baseline.json", command: ["node", ["tests/__baseline__/snapshot-providers.mjs"]] },
  { file: "tests/__baseline__/alias-baseline.json", command: ["node", ["tests/__baseline__/verify-alias.mjs", "--snapshot"]] },
];

/** Provider ids the fork registers; asserted against the built registry. */
export const FORK_PROVIDERS = [
  { id: "claude-cli", alias: "ccli", format: "openai", forceStream: true },
];

/** Fork test files, run from `tests/`. */
export const FORK_TESTS = [
  "unit/agent-skills.test.js",
  "unit/claude-cli-executor.test.js",
  "unit/concurrency-gate.test.js",
  "unit/quota-autoping-cron.test.js",
  "unit/forced-sse-client-format.test.js",
];

/** Live tests; skipped unless REAL_CLI_TESTS=1 and Claude Code is installed. */
export const FORK_LIVE_TESTS = ["real/claude-cli.real.test.js"];
