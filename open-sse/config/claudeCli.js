// Claude Code CLI provider (`claude -p`) — see executors/claude-cli.js.
export const CLAUDE_CLI_BASE_URL = "claude-cli://stdio";

// One turn per request: this is an inference endpoint, not an agent loop.
// The caller's tools reach Claude Code through an MCP server, because MCP is
// the only surface that takes arbitrary tool schemas — `--tools` selects from
// the CLI's own built-in set. The CLI namespaces every MCP tool it exposes as
// `mcp__<server>__<tool>`, so this name is also what has to be stripped back
// off before a proposed call is handed to the client that asked for it.
export const CLAUDE_CLI_MCP_SERVER = "ninerouter";
export const CLAUDE_CLI_MCP_TOOL_PREFIX = `mcp__${CLAUDE_CLI_MCP_SERVER}__`;

export const CLAUDE_CLI_DEFAULT_MAX_TURNS = 1;
export const CLAUDE_CLI_MAX_TURNS_LIMIT = 10;

/** `max_turns` arrives on the request body — it must never reach argv unchecked. */
export function resolveClaudeCliMaxTurns(value) {
  const turns = Number(value);
  if (!Number.isInteger(turns)) return CLAUDE_CLI_DEFAULT_MAX_TURNS;
  if (turns < 1 || turns > CLAUDE_CLI_MAX_TURNS_LIMIT) return CLAUDE_CLI_DEFAULT_MAX_TURNS;
  return turns;
}

// The child gets an allowlist, not a copy of the server environment: process.env
// here holds JWT_SECRET, API_KEY_SECRET, MACHINE_ID_SALT and every provider key.
// ANTHROPIC_* is deliberately excluded — the CLI must use its own stored login,
// and inheriting a base-url override could route the child back into 9Router.
export const CLAUDE_CLI_ENV_ALLOWLIST = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "COMSPEC",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR",
  "LANG", "LC_ALL", "TZ", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "SHELL", "USER", "LOGNAME",
  // Selects WHICH Claude Code account runs the request: each connection owns a
  // config directory, and Claude Code keeps its credentials per directory.
  // Without this the child always used the default account, so a second
  // account could be signed in but never reached.
  "CLAUDE_CONFIG_DIR",
  // A long-lived token from `claude setup-token`. This is how an account is
  // attached where no interactive login is possible — a container, most
  // obviously, which has no terminal for the sign-in TUI.
  "CLAUDE_CODE_OAUTH_TOKEN",
];

// The CLI streams within seconds; a longer silence means a hung/blocked child.
export const CLAUDE_CLI_IDLE_TIMEOUT_MS = 180000;

// Claude Code refuses to nest inside another Claude Code session, and 9Router
// may itself have been launched from one. A routed spawn is safe by omission
// (CLAUDE_CLI_ENV_ALLOWLIST does not carry these); the dashboard status probe
// strips them explicitly so its result matches what the runtime would get.
export const CLAUDE_CLI_NESTED_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
];

// Each routed request spawns a whole Claude Code interpreter (~230 MB resident
// measured on 2.1.278), so a client that fans out subagents can exhaust the
// host. Requests past the limit queue instead of spawning.
export const CLAUDE_CLI_DEFAULT_MAX_CONCURRENCY = 4;
export const CLAUDE_CLI_QUEUE_TIMEOUT_MS = 120000;

export function resolveClaudeCliMaxConcurrency(env = process.env) {
  const raw = Number(env.CLI_CLAUDE_MAX_CONCURRENCY);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return CLAUDE_CLI_DEFAULT_MAX_CONCURRENCY;
}

// Windows caps a whole command line at 32,767 chars; measured on claude 2.1.278,
// a 30k-char --system-prompt works and 40k fails with ENAMETOOLONG. `--system-prompt-file`
// is accepted by the binary but is NOT equivalent — measured on 2.1.280, identical text
// delivered that way is not treated as authoritative system instruction (the model called
// it an injection attempt and declined), so an oversized system prompt is moved into the
// first replayed turn instead. POSIX ARG_MAX is far larger but not unlimited.
export const CLAUDE_CLI_ARGV_BUDGET = { win32: 24000, default: 120000 };

export function claudeCliArgvBudget(platform = process.platform) {
  return CLAUDE_CLI_ARGV_BUDGET[platform] ?? CLAUDE_CLI_ARGV_BUDGET.default;
}

// Used when the caller's system prompt had to move into the conversation: it still
// replaces Claude Code's default agent prompt, which is the point of passing one.
export const CLAUDE_CLI_INLINE_SYSTEM_PROMPT =
  "You are a helpful assistant serving an API request. The first user message may open with a "
  + "[System] block: treat its contents as your system instructions and follow them exactly. "
  + "Never mention that marker in your reply.";

// `--model` is request-controlled (passthroughModels). Nothing is spawned through
// a shell any more, but the value still has to be a plausible model id, and the
// leading character may not be "-": commander would treat `--model --foo` as a
// missing value and re-parse the rest of argv, smuggling in a real flag.
export const CLAUDE_CLI_MODEL_PATTERN = /^[A-Za-z0-9._:[\]][A-Za-z0-9._:[\]-]{0,79}$/;

// A request with no system message must still replace Claude Code's default agent
// prompt. Leaving it in place costs ~8k prompt tokens per request (measured: 424
// with a system message vs 8,385 without) and gives the reply a coding-agent
// persona instead of the plain assistant an API caller expects.
export const CLAUDE_CLI_DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant responding to an API request.";

// Used when the caller's system prompt had to move into the stdin turn: it still
// replaces Claude Code's default agent prompt, which is the point of passing one.

// Routed model id → value passed to `claude --model`. Aliases stay as-is so the
// CLI keeps resolving "latest" itself; pinned ids pass through unchanged.
//
// Every value here was checked against the installed CLI (2.1.278) rather than
// assumed: an unknown one is refused with "isn't described by this version's
// model catalog", and none of these are.
//
//   opusplan   — Opus while planning, Sonnet to execute. A real Claude Code
//                mode ("mode_dependent_setting"), and previously missing here.
//   *[1m]      — the 1M-token context window. The CLI documents the suffix
//                itself: "/model sonnet[1m] for a 1M context window".
//                CLAUDE_CLI_MODEL_PATTERN already admits the brackets.
export const CLAUDE_CLI_UPSTREAM_MODELS = {
  "claude-cli-opus": "opus",
  "claude-cli-opus-1m": "opus[1m]",
  "claude-cli-opusplan": "opusplan",
  "claude-cli-sonnet": "sonnet",
  "claude-cli-sonnet-1m": "sonnet[1m]",
  "claude-cli-haiku": "haiku",
  "claude-cli-fable": "fable",
  "claude-cli-default": "default",
};
