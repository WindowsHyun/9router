/**
 * ClaudeCliExecutor — routes completions through the locally installed
 * Claude Code CLI (`claude -p`) instead of calling api.anthropic.com directly.
 *
 * Why: the `claude` provider drives the Anthropic OAuth endpoint with spoofed
 * CLI headers. Running the real binary keeps the traffic shape identical to an
 * ordinary Claude Code session (same client, same auth path), which removes the
 * ban risk that comes with replaying OAuth tokens from a server.
 *
 * Invocation (verified against claude 2.1.281):
 *   claude -p --output-format stream-json --verbose --include-partial-messages
 *          --model <model> --max-turns 1 --tools ""
 *          --setting-sources "" --strict-mcp-config
 *          --permission-mode dontAsk --disable-slash-commands
 *          --no-session-persistence --input-format stream-json
 *          [--system-prompt-file <path>] [--settings <path>] [--mcp-config <path>]
 *
 *   --tools ""            no Bash/Edit/Write — this is an inference endpoint,
 *                         not an agent loop running on the 9Router host.
 *   --setting-sources ""  ignore user/project/local settings, so the operator's
 *                         own hooks, CLAUDE.md and skills never leak into a
 *                         routed request (measured: 37,835 → 545 input tokens).
 *   --strict-mcp-config   no MCP servers from the host config.
 *   prompt on stdin       Windows caps a command line at ~32k chars.
 *
 * Auth: noAuth — the subprocess uses whatever `claude` itself is logged into
 * (subscription OAuth in ~/.claude, or ANTHROPIC_API_KEY in the host env).
 *
 * Streaming: `--include-partial-messages` emits `stream_event` lines carrying
 * raw Anthropic SSE events, which map 1:1 onto OpenAI chat.completion.chunks.
 *
 * Tool calling: bridged. The CLI's own tools stay off; the caller's are shown
 * through a generated MCP server that advertises them and runs none of them —
 * see claudeCliTools.js — and a proposed call goes back as `tool_calls`.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { BaseExecutor } from "./base.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import { chatChunkSse, sseChunk } from "../utils/sse.js";
import {
  CLAUDE_CLI_BASE_URL,
  CLAUDE_CLI_DEFAULT_MAX_TURNS,
  CLAUDE_CLI_EXIT_GRACE_MS,
  CLAUDE_CLI_TOOL_CALL_PREFIX,
  CLAUDE_CLI_TOOL_RESULT_PREFIX,
  CLAUDE_CLI_IDLE_TIMEOUT_MS,
  CLAUDE_CLI_MCP_TOOL_PREFIX,
  CLAUDE_CLI_MODEL_PATTERN,
  CLAUDE_CLI_DEFAULT_SYSTEM_PROMPT,
  CLAUDE_CLI_CHILD_ENV,
  CLAUDE_CLI_ENV_ALLOWLIST,
  cacheRelayEnabled,
  conflictingHostAuth,
  CLAUDE_CLI_QUEUE_TIMEOUT_MS,
  CLAUDE_CLI_UPSTREAM_MODELS,
  resolveClaudeCliMaxConcurrency,
  resolveClaudeCliMaxTurns,
} from "../config/claudeCli.js";
import { createConcurrencyGate } from "../utils/concurrencyGate.js";
import {
  callerToolName,
  toolNameMap,
  inertMcpServerSource,
  mcpConfigDocument,
  toMcpManifest,
} from "./claudeCliTools.js";
import { buildReplayFrames, describeFrames, framesToStdin } from "./claudeCliReplay.js";
import { recordRateLimitEvent } from "./claudeCliRateLimits.js";
import { startAdmission } from "./claudeCliAdmission.js";
import {
  generationExtraBody,
  ignoredRequestFields,
  outputTokenCeiling,
  toolsAreWanted,
  unsupportedRequestFeature,
} from "./claudeCliRequestSupport.js";

// ─── Binary discovery ────────────────────────────────────────────────────────

function claudeBinCandidates() {
  const home = os.homedir();
  const isWin = process.platform === "win32";
  if (!isWin) {
    return [
      path.join(home, ".local", "bin", "claude"),        // native installer
      path.join(home, ".claude", "local", "claude"),     // legacy local install
      path.join(home, ".bun", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      "/usr/bin/claude",
    ];
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  return [
    path.join(home, ".local", "bin", "claude.exe"),      // native installer
    path.join(localAppData, "Programs", "claude", "claude.exe"),
    path.join(appData, "npm", "claude.cmd"),             // npm -g shim
    path.join(home, "scoop", "shims", "claude.exe"),
    path.join(home, ".bun", "bin", "claude.exe"),
  ];
}

// Exported so the dashboard status route reports exactly what the runtime spawns.
export function resolveClaudeBin() {
  const envBin = process.env.CLI_CLAUDE_BIN?.trim();
  if (envBin) return envBin;

  for (const candidate of claudeBinCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* unreadable path — keep probing */ }
  }
  return process.platform === "win32" ? "claude.exe" : "claude";
}

/**
 * Private working directory for the child.
 *
 * It must not be a shared location: Windows' executable search includes the
 * current directory, so spawning the bare name `claude.exe` (the PATH fallback)
 * from a world-writable `%TEMP%` would run a planted binary. A directory created
 * here cannot be pre-populated by anyone else. It also keeps any stray CLAUDE.md
 * out of the child's view.
 */
let spawnCwd = null;
export function resolveSpawnCwd() {
  if (spawnCwd && fs.existsSync(spawnCwd)) return spawnCwd;
  spawnCwd = fs.mkdtempSync(path.join(os.tmpdir(), "9router-claude-"));
  return spawnCwd;
}

export function resolveShimTarget(bin) {
  const dir = path.dirname(bin);
  const candidates = [
    path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
    path.join(dir, "..", "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return path.resolve(candidate);
    } catch { /* keep probing */ }
  }
  return null;
}

// `.cmd`/`.bat` shims cannot be spawned directly on Windows (Node refuses since
// CVE-2024-27980), and cmd.exe is not the way around it — it has no usable
// escaping, so every argv value would become an injection vector. buildSpawnPlan
// resolves the shim to the package's own cli.js and runs that instead.
export function isShimPath(bin, platform = process.platform) {
  return platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}

/**
 * Always an argv array, never a shell string — the request body can therefore
 * never introduce a second argv element or a shell operator.
 * @returns {{command:string,args:string[],options:object}|{error:string}}
 */
export function buildSpawnPlan(bin, args) {
  if (!isShimPath(bin)) return { command: bin, args, options: {} };

  const target = resolveShimTarget(bin);
  if (!target) {
    return {
      error: "Claude Code resolved to a .cmd shim whose package could not be located. "
        + "Set CLI_CLAUDE_BIN to the claude executable (or the CLI's cli.js).",
    };
  }
  // process.execPath is this server's own Node — no PATH lookup, no shell.
  return { command: process.execPath, args: [target, ...args], options: {} };
}

// ─── Request shaping ─────────────────────────────────────────────────────────

// Tool turns are described here, not marked. This form is only reached when
// the conversation cannot be replayed as turns at all, and a model that reads
// a bracketed `[Tool call ...]` in its own history imitates it — writing the
// marker as text instead of proposing a call, which leaves the client waiting
// for one that never comes.
function blockText(part) {
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.input_text === "string") return part.input_text;
  if (part.type === "tool_use") {
    return `\n${CLAUDE_CLI_TOOL_CALL_PREFIX}${part.name} tool with ${JSON.stringify(part.input ?? {})})\n`;
  }
  if (part.type === "tool_result") {
    const body = typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
    return `\n${CLAUDE_CLI_TOOL_RESULT_PREFIX}${body})\n`;
  }
  return "";
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => (typeof part === "string" ? part : blockText(part))).join("");
  }
  return "";
}

/**
 * Split an OpenAI/Claude message array into the `--system-prompt` payload and a
 * single flattened turn. `claude -p` owns one conversation turn, so prior turns
 * are inlined with role markers — the same approach grok-web/perplexity-web use.
 */
export function buildClaudeCliPrompt(messages) {
  const systemParts = [];
  const turns = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    // "function" is the older OpenAI spelling of "tool"; normalised here so a
    // tool's output is not flattened in as something the user said.
    const rawRole = String(message.role || "user");
    const role = rawRole === "function" ? "tool" : rawRole;
    let text = messageText(message);

    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = message.tool_calls.map((call) => {
        const name = call.function?.name || call.name || "tool";
        const args = call.function?.arguments ?? call.arguments ?? {};
        return `${CLAUDE_CLI_TOOL_CALL_PREFIX}${name} tool with ${typeof args === "string" ? args : JSON.stringify(args)})`;
      });
      text = [text, ...calls].filter(Boolean).join("\n\n");
    }
    if (role === "tool") {
      const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      text = `${CLAUDE_CLI_TOOL_RESULT_PREFIX}${body})`;
    }
    if (!text.trim()) continue;

    if (role === "system" || role === "developer") systemParts.push(text);
    else if (role === "assistant") turns.push(`[Assistant]\n${text}`);
    else if (role === "tool") turns.push(`[Tool]\n${text}`);
    else turns.push(`[User]\n${text}`);
  }

  // A single user turn needs no role marker — keep the prompt as close to a
  // plain question as possible so the model does not mimic the transcript shape.
  const onlyUserTurn = turns.length === 1 && turns[0].startsWith("[User]\n");
  const turnsText = turns.join("\n\n");
  return {
    system: systemParts.join("\n\n"),
    prompt: onlyUserTurn ? turns[0].slice("[User]\n".length) : turnsText,
    // Role-marked form, used when the system prompt has to ride along in stdin.
    turnsText,
  };
}

/**
 * Decide how one request reaches the CLI.
 *
 * The system prompt goes on argv when it safely fits, because a real
 * `--system-prompt` has higher fidelity than instructions embedded in the turn.
 * It moves into stdin only when it would blow the platform's command-line limit.
 * (Nothing is ever spawned through a shell, so argv itself is not an injection
 * surface — see buildSpawnPlan.)
 */
export function planClaudeCliInvocation({ model, messages, maxTurns, tools }) {
  const { system, prompt } = buildClaudeCliPrompt(messages);
  // Advertised to the CLI through MCP, never executed here — see
  // claudeCliTools.js. It leaves the plan as data so the spawn can write it to
  // a file, which keeps this function a pure function of the request.
  const manifest = toMcpManifest(tools);
  // One turn per request, always — the same value the Hermes plugin passes.
  //
  // With tools advertised it is forced anyway: given another turn the CLI would
  // go on to *invoke* the inert server, read its refusal, and answer with an
  // apology, losing the tool call the client was waiting for. Without tools it
  // used to honour a caller's `max_turns`, which is a 9Router extension the
  // plugin does not have — and it is incompatible with admitting exactly one
  // model call through the cache relay. An agent loop belongs to the client;
  // this endpoint answers once.
  const turnLimit = CLAUDE_CLI_DEFAULT_MAX_TURNS;

  // Replay the conversation as turns when it can be: the model then has had the
  // conversation rather than reading a transcript of one, and a tool result is
  // a result linked to the call that produced it instead of a line of prose.
  const replay = buildReplayFrames(messages, CLAUDE_CLI_MCP_TOOL_PREFIX);
  const replayed = Boolean(replay.frames);

  return {
    args: buildClaudeCliArgs({ model, maxTurns: turnLimit, streamJsonInput: replayed }),
    stdin: replayed ? framesToStdin(replay.frames) : prompt,
    // Recorded with the request so a looping client can be diagnosed from the
    // dashboard instead of from a guess.
    shape: replayed ? describeFrames(replay.frames) : { turns: 0, flattened: true },
    // Never empty: without a system prompt Claude Code applies its own agent
    // prompt, which is neither what an API caller asked for nor what they
    // expect to pay for. It goes to a file, so its size never matters.
    system: (replayed ? replay.system : system) || CLAUDE_CLI_DEFAULT_SYSTEM_PROMPT,
    frameCount: replayed ? replay.frames.length : 0,
    // The content of the turn actually being asked. The admission relay needs
    // it to tell 9Router's own blocks from the per-request context the CLI
    // appends to that same turn — which is where the cache breakpoint must not
    // land. Only meaningful for a replayed conversation.
    queried: replayed ? (replay.frames.at(-1)?.message?.content || null) : null,
    replayed,
    manifest,
  };
}


/** Resolved upstream model id, or null when it is not safe to put on argv. */
export function resolveClaudeCliModel(model) {
  const upstream = CLAUDE_CLI_UPSTREAM_MODELS[model] || model;
  if (!upstream) return null;
  return CLAUDE_CLI_MODEL_PATTERN.test(upstream) ? upstream : null;
}

export function buildClaudeCliArgs({
  model, system, systemPromptFile, settingsFile, maxTurns, mcpConfigFile, streamJsonInput,
} = {}) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--max-turns", String(resolveClaudeCliMaxTurns(maxTurns)),
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    // Nothing here may wait for a human. Without these the CLI can stop on a
    // permission prompt with no terminal to answer it, which reaches the client
    // as a stream that simply stops.
    "--permission-mode", "dontAsk",
    "--disable-slash-commands",
    // One request is one turn; a saved session would accumulate on the host and
    // is never resumed, because every request arrives carrying its own history.
    "--no-session-persistence",
  ];
  // History goes in as real turns rather than a transcript pasted into one
  // prompt — see claudeCliReplay.js.
  if (streamJsonInput) args.push("--input-format", "stream-json");
  const upstreamModel = resolveClaudeCliModel(model);
  if (upstreamModel) args.push("--model", upstreamModel);
  // From a file: a coding agent's system prompt runs past the 32,767 characters
  // Windows allows a whole command line, and measured on 2.1.280 the file is
  // read with the same authority as the flag — a 37k prompt was followed, and
  // its prefix cached between requests. `system` stays for a caller that has
  // nowhere to write one.
  if (systemPromptFile) args.push("--system-prompt-file", systemPromptFile);
  else if (system) args.push("--system-prompt", system);
  // Carries CLAUDE_CODE_EXTRA_BODY into the child, which is how temperature, a
  // token ceiling and stop sequences reach the upstream request at all.
  if (settingsFile) args.push("--settings", settingsFile);
  // The caller's tools, behind the inert MCP server. Omitted entirely when the
  // request has none, so a plain chat spawns no extra process.
  if (mcpConfigFile) args.push("--mcp-config", mcpConfigFile);
  return args;
}

/**
 * The child gets only what it needs to run. Copying process.env would hand every
 * routed request's subprocess the server's JWT_SECRET, API_KEY_SECRET and every
 * stored provider key; the CLAUDE_CODE* nesting markers are excluded by omission,
 * which is also what stops Claude Code refusing to run inside another session.
 */
function buildChildEnv(env = process.env, account = {}) {
  const child = {};
  for (const key of CLAUDE_CLI_ENV_ALLOWLIST) {
    if (env[key] !== undefined) child[key] = env[key];
  }
  Object.assign(child, CLAUDE_CLI_CHILD_ENV);
  // Two ways to pin which account runs the request:
  //   configDir   — a Claude Code config directory, written by an interactive
  //                 /login. The natural choice on a desktop.
  //   oauthToken  — a long-lived token from `claude setup-token`. The only
  //                 choice in a container, where there is no terminal to sign
  //                 in with. It overrides whatever the directory has stored.
  const configDir = typeof account?.configDir === "string" ? account.configDir.trim() : "";
  const oauthToken = typeof account?.oauthToken === "string" ? account.oauthToken.trim() : "";
  // A pinned account replaces the host's login rather than sitting beside it.
  // Both names are on the allowlist, so a server holding one in its own
  // environment was handing it to every child — and since a token overrides a
  // directory, an account attached by directory silently ran as the host's:
  // wrong subscription billed, wrong quota card, and the connection the
  // operator attached never used at all. With no account pinned the host's own
  // login is still the right one to use.
  if (configDir || oauthToken) {
    delete child.CLAUDE_CONFIG_DIR;
    delete child.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (configDir) child.CLAUDE_CONFIG_DIR = configDir;
  if (oauthToken) child.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return child;
}

export const __testables = { buildChildEnv };

// ─── stream-json → OpenAI chunks ─────────────────────────────────────────────

const FINISH_REASONS = {
  max_tokens: "length",
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  // Both are ordinary ends of a turn as far as an OpenAI client is concerned:
  // the model declined, or the API paused a long-running turn. Left unmapped
  // they fell through to "stop" anyway — named so the next reader can see that
  // is deliberate rather than an omission.
  refusal: "stop",
  pause_turn: "stop",
};

function usagePayload(usage) {
  if (!usage) return undefined;
  const promptTokens = (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
  const completionTokens = usage.output_tokens || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/**
 * The per-request state translateClaudeCliEvent threads through one stream.
 *
 * Exported so a test drives the translator with the same state the executor
 * gives it — a hand-rolled copy would drift from the real one, and the tool
 * bookkeeping is exactly where that would go unnoticed.
 */
export function createClaudeCliContext({ id, created, model, toolNames = null, tokenCeiling = false }) {
  return {
    id,
    created,
    model,
    roleSent: false,
    stopReason: null,
    usage: null,
    // Whether this request asked for a bounded answer. The CLI flags a turn its
    // output ceiling cut short as an error, content and all, and that content is
    // exactly what the caller asked for — just less of it.
    tokenCeiling,
    // The CLI's name for each advertised tool → the name the caller sent. The
    // namespacing is not reversible on its own: a dot in the caller's name
    // comes back as an underscore.
    toolNames,
    // content-block index -> tool_calls index, so argument fragments land on
    // the call they belong to. Text and tool blocks share one index space.
    toolBlocks: new Map(),
    toolCount: 0,
    sawToolCall: false,
    // What has already gone out as deltas. The complete message the CLI also
    // emits repeats it, and comparing the text is what tells a repeat from a
    // block that never streamed — measured order is deltas first, then the
    // complete block, but a flag alone would also drop a second block that
    // only ever appeared in the complete form.
    streamedText: "",
    toolIdsSeen: new Set(),
    // Whether the CLI is sending partial messages at all. It is asked to, so
    // in practice every block arrives twice; a block with no id can only be
    // told apart from the streamed copy of itself by this.
    sawStreamEvent: false,
    // Whether anything the client can act on has gone out. Distinct from
    // roleSent, which thinking also sets: a turn that produced only thinking
    // has opened a message and said nothing, and that is the shape an agent
    // cannot make progress on.
    sentAnswer: false,
  };
}

/**
 * An error the client can actually see.
 *
 * A choice-less `{error: ...}` frame is the OpenAI convention, and an
 * OpenAI-format client reads it. It is also dropped whole on the way to a
 * Claude- or Gemini-format client: `openaiToClaudeResponse` returns null for
 * any chunk without `choices[0]`, so for those clients the stream simply
 * ended — no content, no finish_reason, nothing said. An agent reads that as an
 * empty turn and tries the same step again, which is what "it just loops"
 * looks like from outside. So the message also goes out as ordinary content,
 * followed by a finish that every format carries.
 */
export function errorFrames(ctx, message, code) {
  const text = `[9Router] ${message}`;
  const frames = [sseChunk({ error: { message: String(message), type: "claude_cli_error", code } })];
  const delta = ctx.roleSent ? { content: `\n${text}` } : { role: "assistant", content: text };
  ctx.roleSent = true;
  const chunkFor = (d, finishReason = null) => chatChunkSse({
    id: ctx.id, created: ctx.created, model: ctx.model, delta: d, finishReason,
  });
  frames.push(chunkFor(delta));
  frames.push(chunkFor({}, "stop"));
  return frames;
}

/**
 * Translate one `claude --output-format stream-json` line into OpenAI SSE frames.
 * Returns `{ frames, finished }`; never throws — an unknown line yields nothing.
 */
export function translateClaudeCliEvent(event, ctx) {
  const frames = [];
  const chunk = (delta, finishReason = null) =>
    frames.push(chatChunkSse({ id: ctx.id, created: ctx.created, model: ctx.model, delta, finishReason }));

  if (event?.type === "stream_event") {
    ctx.sawStreamEvent = true;
    const inner = event.event;
    if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
      // The model proposes, the client executes. Opening the call as soon as
      // the block starts — rather than waiting for the whole thing — is what
      // every other provider does, and it lets the client read the name while
      // the arguments are still arriving.
      const block = inner.content_block;
      const index = ctx.toolCount++;
      ctx.toolBlocks.set(inner.index, index);
      ctx.sawToolCall = true;
      if (block.id) ctx.toolIdsSeen.add(block.id);
      const call = {
        index,
        id: block.id || `call_${index}`,
        type: "function",
        // The CLI namespaces every MCP tool; the client only knows the name it
        // sent, so it gets that one back.
        function: { name: callerToolName(block.name, ctx.toolNames), arguments: "" },
      };
      ctx.sentAnswer = true;
      if (!ctx.roleSent) { ctx.roleSent = true; chunk({ role: "assistant", tool_calls: [call] }); }
      else chunk({ tool_calls: [call] });
    } else if (inner?.type === "content_block_delta") {
      const delta = inner.delta || {};
      if (delta.type === "text_delta" && delta.text) {
        ctx.streamedText += delta.text;
        ctx.sentAnswer = true;
        if (!ctx.roleSent) { ctx.roleSent = true; chunk({ role: "assistant", content: delta.text }); }
        else chunk({ content: delta.text });
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        if (!ctx.roleSent) { ctx.roleSent = true; chunk({ role: "assistant", reasoning_content: delta.thinking }); }
        else chunk({ reasoning_content: delta.thinking });
      } else if (delta.type === "input_json_delta" && delta.partial_json) {
        // Arguments arrive as JSON fragments that only parse once joined, which
        // is exactly the shape an OpenAI client already reassembles.
        const index = ctx.toolBlocks.get(inner.index);
        if (index !== undefined) {
          chunk({ tool_calls: [{ index, function: { arguments: delta.partial_json } }] });
        }
      }
    } else if (inner?.type === "message_delta") {
      if (inner.delta?.stop_reason) ctx.stopReason = inner.delta.stop_reason;
      if (inner.usage) ctx.usage = { ...ctx.usage, ...inner.usage };
    } else if (inner?.type === "message_start") {
      // Per message, not per request: the complete message is compared against
      // what streamed, and a buffer that carried every earlier turn's text
      // would suppress a later block that merely repeats a phrase — which for
      // a short block ("Okay.", ".", a newline) is close to certain.
      ctx.streamedText = "";
      // Content-block indices restart at 0 with each message, so a mapping left
      // over from the last one would route this message's argument fragments
      // onto the previous message's call. Not reachable while tools pin the
      // turn limit to 1, but that pinning is a decision made elsewhere.
      ctx.toolBlocks.clear();
      if (inner.message?.usage) ctx.usage = { ...ctx.usage, ...inner.message.usage };
    }
    return { frames, finished: false };
  }

  // The complete message, which the CLI emits alongside the partial ones.
  // Everything in it has normally already gone out as deltas, and each block is
  // skipped when it has — so this adds nothing to an ordinary stream. It exists
  // for the case where the deltas do not arrive: the response then carried
  // output tokens and no content at all, which reaches a client as an assistant
  // turn with nothing in it and nothing to do, and an agent that keeps trying.
  if (event?.type === "assistant") {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of blocks) {
      if (block?.type === "text" && block.text && !ctx.streamedText.includes(block.text)) {
        ctx.sentAnswer = true;
        if (!ctx.roleSent) { ctx.roleSent = true; chunk({ role: "assistant", content: block.text }); }
        else chunk({ content: block.text });
      } else if (block?.type === "tool_use") {
        // Keyed on the id when there is one, and on what the call would do when
        // there is not — requiring an id here dropped such a call in silence,
        // while the streamed path made one up. A dropped call is a client
        // waiting for something that never arrives.
        //
        // An id-less block is only new when nothing streamed: the streamed
        // copy of it was sent under a made-up id that cannot be matched here,
        // and sending it twice would have the client run the tool twice.
        if (!block.id && ctx.sawStreamEvent) continue;
        const key = block.id || `${block.name}:${JSON.stringify(block.input ?? {})}`;
        if (ctx.toolIdsSeen.has(key)) continue;
        ctx.toolIdsSeen.add(key);
        ctx.sawToolCall = true;
        const call = {
          index: ctx.toolCount,
          id: block.id || `call_${ctx.toolCount}`,
          type: "function",
          function: {
            name: callerToolName(block.name, ctx.toolNames),
            // Already whole here, unlike the fragments a delta carries.
            arguments: JSON.stringify(block.input ?? {}),
          },
        };
        ctx.toolCount += 1;
        ctx.sentAnswer = true;
        if (!ctx.roleSent) { ctx.roleSent = true; chunk({ role: "assistant", tool_calls: [call] }); }
        else chunk({ tool_calls: [call] });
      }
    }
    return { frames, finished: false };
  }

  if (event?.type === "result") {
    // Replaying history produces one of these per historical frame. A
    // `shouldQuery: false` turn is accepted without calling the model, and the
    // CLI reports that as a result with num_turns 0 and nothing in it. Only the
    // query's own result ends the stream — taking an acknowledgment for the end
    // would close the response before a single token arrived, which is exactly
    // what "the output stops" looks like from outside.
    // An error is never an acknowledgment, whatever its turn count says: the
    // CLI reports a startup failure with no turns at all, and swallowing that
    // leaves the request to end as a bare "exited before completing".
    if (event.num_turns === 0 && event.is_error !== true) return { frames, finished: false };
    if (!ctx.stopReason && event.stop_reason) ctx.stopReason = event.stop_reason;
    // A turn that ends by proposing a tool call always trips --max-turns: the
    // CLI is holding an unanswered call with no turn left to answer it, so it
    // reports subtype "error_max_turns" with is_error true. That is the agent
    // loop's verdict, not the completion's — the call itself is complete, and
    // running it belongs to the client that supplied the tool. Reading it as a
    // failure is what cut the stream off mid-answer for every tool-using
    // client.
    const proposedToolCall = ctx.sawToolCall && event.stop_reason === "tool_use";
    // Reaching the caller's token ceiling is a completion that stopped early,
    // which is what the API itself reports as stop_reason "max_tokens". The CLI
    // calls it an error instead — it is an agent that ran out of room — and
    // handing that on would turn an ordinary bounded request into a failure,
    // for a field every Anthropic client is required to send.
    // An error result carries its reason in `errors`, not in `result` — only
    // the success variant has a `result` at all. Reading just `result` handed
    // every CLI failure to the client as "Claude CLI returned <subtype>" with
    // the cause thrown away.
    const errorText = Array.isArray(event.errors) ? event.errors.filter(Boolean).join("; ") : "";
    const hitTokenCeiling = event.is_error === true
      && /exceeded the [0-9]+ output token maximum/i.test(`${event.result || ""} ${errorText}`);
    if (hitTokenCeiling) ctx.stopReason = "max_tokens";
    // The other shape a ceiling takes. Measured on 2.1.281: with
    // CLAUDE_CODE_MAX_OUTPUT_TOKENS set low, a bound turn comes back
    // `is_error: true` with `stop_reason: "stop_sequence"` — and with its
    // content intact. That content is what the caller asked for, only shorter,
    // so reading it as a failure threw away the answer to a request that was
    // answered. Only when this request set a ceiling: a caller's own stop
    // sequence produces the same stop_reason and is an ordinary end.
    const ceilingCutItShort = ctx.tokenCeiling
      && event.is_error === true
      && event.stop_reason === "stop_sequence";
    if (ceilingCutItShort) ctx.stopReason = "max_tokens";
    // `is_error` can otherwise ride along with subtype "success" (e.g. an
    // upstream 529 the CLI surfaced as its final text). Delivering that as
    // assistant content would hand the client a successful completion whose
    // body is an error message.
    if (!proposedToolCall && !hitTokenCeiling && !ceilingCutItShort
      && (event.subtype !== "success" || event.is_error === true)) {
      const message = event.error || errorText || event.startup_failure_reason
        || event.result || `Claude CLI returned ${event.subtype}`;
      const code = event.subtype !== "success" ? event.subtype : "upstream_error";
      frames.push(...errorFrames(ctx, message, code));
      return { frames, finished: true };
    }
    if (event.usage) ctx.usage = { ...ctx.usage, ...event.usage };
    // A non-streaming fallback: emit the final text if no delta ever arrived.
    // Not when the ceiling was hit: `result` is the CLI's error text there, and
    // handing that to the caller as the assistant's answer is worse than an
    // empty one that says why it stopped.
    // Keyed on whether an answer went out, not on whether a message was opened.
    // Thinking opens one and answers nothing, and a turn that ends there used
    // to reach the client empty — which is an agent with nothing to act on, and
    // the reason one kept retrying the same step.
    if (!hitTokenCeiling && !ctx.sentAnswer && typeof event.result === "string" && event.result) {
      ctx.sentAnswer = true;
      if (!ctx.roleSent) { ctx.roleSent = true; chunk({ role: "assistant", content: event.result }); }
      else chunk({ content: event.result });
    }
    // A turn that produced nothing at all: no delta, no tool call, and a result
    // whose text is empty — measured on a turn that only thought. Handing that
    // on as a successful, empty assistant message is the shape an agent retries
    // on forever, so it is reported as what it is.
    //
    // Only for a turn that ended of its own accord. Every other stop reason —
    // a token ceiling, a proposed call, a stop sequence, a refusal — already
    // says on the finish chunk why there is nothing, and that is an answer.
    const endedOnItsOwn = !ctx.stopReason || ctx.stopReason === "end_turn";
    if (!hitTokenCeiling && !ceilingCutItShort && !proposedToolCall && !ctx.sentAnswer && endedOnItsOwn) {
      frames.push(...errorFrames(
        ctx,
        "Claude CLI ended the turn without producing any content.",
        "empty_response",
      ));
      return { frames, finished: true };
    }
    const usage = usagePayload(ctx.usage);
    frames.push(sseChunk({
      id: ctx.id,
      object: "chat.completion.chunk",
      created: ctx.created,
      model: ctx.model,
      choices: [{ index: 0, delta: {}, finish_reason: FINISH_REASONS[ctx.stopReason] || "stop" }],
      ...(usage ? { usage } : {}),
    }));
    return { frames, finished: true };
  }

  return { frames, finished: false };
}

/**
 * Write what this request needs the CLI to read from disk.
 *
 * The system prompt, because a coding agent's runs to tens of thousands of
 * characters and Windows caps a command line at 32,767. The generation fields,
 * because the CLI has no flags for them and reads them from a settings file.
 * And the tool inventory, with the MCP server that serves it.
 *
 * Per request, in its own directory: two requests advertise different tools and
 * the CLI starts the server when it feels like it, so a shared path would let a
 * late start pick up another request's inventory.
 *
 * Returns null when there is genuinely nothing to write, or when writing fails
 * — the caller then puts the system prompt back on argv rather than dropping
 * it.
 */
function writeRequestFiles({ manifest, system, extraBody, log }) {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-claude-req-"));
    const files = { dir };
    if (system) {
      files.systemPath = path.join(dir, "system.md");
      fs.writeFileSync(files.systemPath, system);
    }
    if (extraBody) {
      // The CLI reads env out of a settings file and applies it inside its own
      // process, which is how a body this large gets past the per-argument and
      // per-environment-string limits an exec would impose.
      files.settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(files.settingsPath, JSON.stringify({
        env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(extraBody) },
      }));
    }
    if (manifest?.length) {
      // .cjs so the extension decides the module kind: a temp directory has no
      // package.json to consult, and the generated program is a plain script.
      const serverPath = path.join(dir, "inert-mcp.cjs");
      files.configPath = path.join(dir, "mcp.json");
      fs.writeFileSync(serverPath, inertMcpServerSource(manifest));
      fs.writeFileSync(files.configPath, JSON.stringify(
        mcpConfigDocument(process.execPath, serverPath),
      ));
    }
    return files;
  } catch (e) {
    // Losing the tools is bad; failing the request over a temp file is worse.
    // The caller then gets a plain answer instead of a tool call — which is
    // indistinguishable, from the outside, from a model that chose not to call
    // one, so say plainly that this is why.
    log?.info?.("CLAUDE-CLI",
      `request files could not be written (${e.message}); `
      + "the caller's tools are not advertised for this request");
    return null;
  }
}

/**
 * Stop the interpreter and everything it started.
 *
 * `child.kill()` signals one process. Claude Code spawns its own children —
 * the MCP server here, and on Windows the npm shim is cmd.exe wrapping node —
 * and those keep the request's pipes open after the parent is gone, so a
 * cancelled request would linger and hold its gate slot. Kill the tree.
 */
function killClaudeCliTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" })
        .on("error", () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
      return;
    }
    // Spawned detached, so the child leads its own group: the negated pid
    // reaches every descendant in one call.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// One gate per server process (survives Next.js module reloads).
const spawnGate = (globalThis.__claudeCliGate ??= createConcurrencyGate({
  limit: () => resolveClaudeCliMaxConcurrency(),
  queueTimeoutMs: CLAUDE_CLI_QUEUE_TIMEOUT_MS,
}));

export function claudeCliGateStats() {
  return spawnGate.stats();
}

/**
 * Failure detected before any byte was streamed. It gets a real HTTP status, not
 * a 200 with an error frame: chat.js drives account/combo fallback off
 * `result.status`, and a 200 also disappears entirely for Claude- and
 * Gemini-format clients, whose translators drop choice-less frames.
 */
function errorResponse(message, code, status = 503) {
  const body = sseChunk({ error: { message, type: "claude_cli_error", code } }) + SSE_DONE;
  return new Response(body, { status, headers: SSE_HEADERS });
}

// ─── ClaudeCliExecutor ───────────────────────────────────────────────────────

export class ClaudeCliExecutor extends BaseExecutor {
  constructor() {
    super("claude-cli", { id: "claude-cli", baseUrl: CLAUDE_CLI_BASE_URL, noAuth: true });
  }

  buildUrl() {
    return CLAUDE_CLI_BASE_URL;
  }

  buildHeaders() {
    return {};
  }

  transformRequest() {
    return null;
  }

  async execute({ model, body, credentials, signal, log }) {
    const b = body ?? {};
    const messages = Array.isArray(b.messages) ? b.messages : Array.isArray(b.input) ? b.input : [];
    const bin = resolveClaudeBin();

    if (!resolveClaudeCliModel(model)) {
      return { response: errorResponse(`Unsupported model id for the Claude Code CLI: ${model}`, "invalid_model", 400) };
    }

    // Refused before anything is spawned: these change the shape of the answer
    // the caller promised someone else, and the CLI cannot give them. Answering
    // anyway would be answering a different question.
    const unsupported = unsupportedRequestFeature(b);
    if (unsupported) {
      return { response: errorResponse(unsupported.message, unsupported.code, 400) };
    }
    // Carried into the child through a settings file, which is the only way the
    // CLI takes them — it has no flags for temperature or a token ceiling.
    const extraBody = generationExtraBody(b);
    // A ceiling the CLI takes only through its own environment variable; see
    // outputTokenCeiling for what it does and does not honour.
    const tokenCeiling = outputTokenCeiling(b);
    // What is left has no equivalent anywhere below the CLI. Named in the log
    // so the difference is visible when output is not what someone expected.
    const ignored = ignoredRequestFields(b);
    if (ignored.length) {
      log?.info?.("CLAUDE-CLI", `no equivalent in the CLI, ignored: ${ignored.join(", ")}`);
    }

    const invocation = planClaudeCliInvocation({
      model,
      messages,
      maxTurns: b.max_turns,
      // tool_choice "none" is honoured by not advertising them at all, which is
      // the one part of tool_choice this provider can actually implement.
      tools: toolsAreWanted(b) ? b.tools : undefined,
    });
    const stdin = invocation.stdin;
    // A request whose messages are all system or all blank leaves nothing to
    // ask. The CLI takes it, waits on a prompt that never comes, and holds one
    // of only four spawn slots until the idle timeout three minutes later —
    // four of those and every other request queues behind them.
    if (!String(stdin).trim()) {
      return {
        response: errorResponse(
          "The request carries no message to answer: Claude Code CLI needs a user "
          + "turn, and a system prompt on its own is not one.",
          "empty_prompt",
          400,
        ),
      };
    }
    // Only the binary can make a plan invalid, so this is settled before any
    // file is written — the tool files come later, once the request is going
    // to spawn.
    const basePlan = buildSpawnPlan(bin, invocation.args);
    if (basePlan.error) {
      log?.info?.("CLAUDE-CLI", basePlan.error);
      return { response: errorResponse(basePlan.error, "unsupported_binary", 503) };
    }

    // A tool whose name the MCP inventory cannot carry is dropped rather than
    // allowed to take the whole request down with it — but silently dropping
    // it leaves the caller with prose where they expected a call, and no way
    // to tell that from a model that simply chose not to call one.
    // Said once per request rather than never: these are neutralised by the
    // allowlist, so the account that runs is the right one — but an operator who
    // set one of them is expecting something else to happen.
    const conflicts = conflictingHostAuth();
    if (conflicts.length) {
      log?.info?.("CLAUDE-CLI",
        `ignoring host ${conflicts.join(", ")}: this provider always runs the `
        + "account attached to the connection, on the Claude subscription");
    }

    const toolsAsked = toolsAreWanted(b) && Array.isArray(b.tools) ? b.tools.length : 0;
    if (toolsAsked > invocation.manifest.length) {
      log?.info?.("CLAUDE-CLI",
        `${toolsAsked - invocation.manifest.length} of ${toolsAsked} tools were not advertised: `
        + "a tool name must be 1-111 characters of letters, digits, underscore, dot or hyphen");
    }

    log?.info?.(
      "CLAUDE-CLI",
      `claude -p → model=${model}, bin=${bin}, stdinChars=${stdin.length}`
        + (invocation.manifest.length ? `, tools=${invocation.manifest.length}` : "")
        + (invocation.replayed ? `, replayed ${invocation.frameCount} turns` : ", flattened prompt")
        + (extraBody ? `, body=${Object.keys(extraBody).join("/")}` : "")
    );
    // Wait for a spawn slot before opening the stream, so a burst queues instead
    // of starting N interpreters at once.
    let releaseSlot;
    try {
      releaseSlot = await spawnGate.acquire(signal);
    } catch (e) {
      const stats = spawnGate.stats();
      return {
        response: errorResponse(
          e.code === "aborted"
            ? "Request aborted while queued for a Claude CLI slot"
            : `${e.message}. Raise CLI_CLAUDE_MAX_CONCURRENCY (currently ${stats.limit}) if this host can afford more.`,
          e.code || "queue_failed",
        ),
      };
    }

    // After the slot, deliberately: a request that queues out or is abandoned
    // never spawns, so it should never leave a directory behind either.
    const requestFiles = writeRequestFiles({ ...invocation, extraBody, log });
    // Once per request, on every path that can end it.
    //
    // Retried once, because the MCP server is a grandchild: it exits when the
    // interpreter closes its stdin, which can be a moment after the "close"
    // this runs from. Windows refuses to delete a script a live process is
    // still executing, and giving up there would leak a directory per request.
    // The relay that moves the prompt-cache breakpoint. Without it the CLI marks
    // the turn it is answering, which the next request replays without the
    // per-request context the CLI added — so the cached prefix never recurs and
    // every round of an agent loop reprocesses the whole history. Measured:
    // identical input reads 40k of cache, input differing by one word reads
    // none. See claudeCliAdmission.js.
    let admission = null;
    if (invocation.queried && cacheRelayEnabled()) {
      try {
        admission = await startAdmission({ queried: invocation.queried });
      } catch (e) {
        // Routing straight to the API still answers; it just answers slowly.
        log?.info?.("CLAUDE-CLI", `cache relay unavailable (${e.message}); prompt caching will not apply`);
      }
    }

    let toolFilesRemoved = false;
    const cleanupToolFiles = (retry = true) => {
      if (admission) { admission.close(); admission = null; }
      if (!requestFiles || toolFilesRemoved) return;
      try {
        fs.rmSync(requestFiles.dir, { recursive: true, force: true });
        toolFilesRemoved = true;
      } catch {
        if (!retry) return;
        // Unref'd: this must never be the reason the process stays alive.
        const timer = setTimeout(() => cleanupToolFiles(false), 2000);
        if (timer.unref) timer.unref();
      }
    };
    const extraArgs = [];
    if (requestFiles?.systemPath) extraArgs.push("--system-prompt-file", requestFiles.systemPath);
    // Only when the file could not be written: dropping the system prompt would
    // hand the caller Claude Code's own agent prompt instead of theirs.
    //
    // A prompt too large for the command line (Windows caps it at 32,767) makes
    // spawn throw, and that path returns a 503 the client can see, having
    // already given back the gate slot and the request directory. So the worst
    // case here is a visible failure, not a request quietly answered without
    // the instructions it was given — which is what makes trying worthwhile.
    else if (invocation.system) extraArgs.push("--system-prompt", invocation.system);
    if (requestFiles?.settingsPath) extraArgs.push("--settings", requestFiles.settingsPath);
    if (requestFiles?.configPath) extraArgs.push("--mcp-config", requestFiles.configPath);
    const plan = extraArgs.length ? buildSpawnPlan(bin, [...invocation.args, ...extraArgs]) : basePlan;

    const ctx = createClaudeCliContext({
      toolNames: toolNameMap(invocation.manifest),
      tokenCeiling: Boolean(tokenCeiling),
      id: `chatcmpl-${Date.now().toString(36)}`,
      created: Math.floor(Date.now() / 1000),
      model,
    });

    // Spawn first and wait for the OS to accept it. Node emits "spawn" or
    // "error" (ENOENT for a missing install) before anything is streamed, so a
    // failure here can still become a real HTTP status instead of a 200 whose
    // only error signal is an SSE frame a Claude-format client would drop.
    let child;
    try {
      child = spawn(plan.command, plan.args, {
        env: {
          ...buildChildEnv(process.env, credentials?.providerSpecificData),
          ...(admission ? { ANTHROPIC_BASE_URL: admission.url } : {}),
          ...(tokenCeiling ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: tokenCeiling } : {}),
        },
        // This request's own directory when it has one, so nothing it writes
        // outlives it. Never the 9Router process cwd, and never a shared temp
        // dir — see resolveSpawnCwd for why it has to be one we created.
        cwd: requestFiles?.dir || resolveSpawnCwd(),
        stdio: ["pipe", "pipe", "pipe"],
        // Leads its own process group, so killClaudeCliTree can reach the MCP
        // server and anything else the interpreter starts. Not on Windows,
        // where detaching would open a console window; taskkill /T walks the
        // tree there without one.
        detached: process.platform !== "win32",
        ...plan.options,
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (err) {
      releaseSlot();
      cleanupToolFiles();
      const notFound = err?.code === "ENOENT" || /ENOENT|not found/i.test(err?.message || "");
      log?.info?.("CLAUDE-CLI", `spawn failed for ${bin}: ${err?.message}`);
      return {
        response: errorResponse(
          notFound
            ? "Claude Code CLI not found on the 9Router host. Install it (https://claude.com/claude-code) or set CLI_CLAUDE_BIN."
            : "Claude CLI could not be started on the 9Router host.",
          notFound ? "not_installed" : "spawn_failed",
          503,
        ),
      };
    }

    // One release for every path that can end this request, including the case
    // where the body is never read at all.
    let slotReleased = false;
    const freeSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      releaseSlot();
    };

    let streamTeardown = null;
    const sseStream = new ReadableStream({
      // Runs at construction, before anything reads the body — so the child is
      // always wired up and always reaped, even if the response is discarded.
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        // The consumer can cancel the body at any time (client disconnect, stall
        // handling); enqueueing into a cancelled controller throws synchronously
        // from inside a stdout listener, which would be an uncaught exception.
        const emit = (frame) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(frame)); } catch { closed = true; }
        };
        const finish = () => {
          if (closed) return;
          closed = true;
          try { controller.enqueue(encoder.encode(SSE_DONE)); } catch { /* already torn down */ }
          try { controller.close(); } catch { /* already closed */ }
        };
        // Same shape as a failure reported by the CLI itself, so a Claude- or
        // Gemini-format client sees these too rather than a stream that ends.
        const fail = (message, code) => {
          for (const frame of errorFrames(ctx, message, code)) emit(frame);
          finish();
        };

        // The gate slot and the temp directory are given back by the `close`
        // handler, and `close` waits for the child's pipes — which the child's
        // own children can hold open after it is done. Every path that ends the
        // request goes through here so that something is still watching: the
        // child gets a moment to leave on its own, then it is made to, and if
        // even that produces no `close` the slot is given back anyway. One
        // interpreter too many is survivable; a slot that never comes back
        // wedges every later request behind a 120s queue.
        const exitTimers = [];
        const after = (ms, fn) => {
          const timer = setTimeout(fn, ms);
          if (timer.unref) timer.unref();
          exitTimers.push(timer);
        };
        const settleChild = ({ now = false } = {}) => {
          if (now) killClaudeCliTree(child);
          else after(CLAUDE_CLI_EXIT_GRACE_MS, () => killClaudeCliTree(child));
          after(CLAUDE_CLI_EXIT_GRACE_MS * 2, freeSlot);
        };

        // Exposed to cancel() below, which runs outside this closure.
        streamTeardown = () => {
          closed = true;
          // Runs after start() has finished, so the timer helpers below exist.
          clearIdleTimer();
          settleChild({ now: true });
        };

        let idleTimer = null;
        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            fail(`Claude CLI produced no output for ${CLAUDE_CLI_IDLE_TIMEOUT_MS}ms`, "idle_timeout");
            settleChild({ now: true });
          }, CLAUDE_CLI_IDLE_TIMEOUT_MS);
          if (idleTimer.unref) idleTimer.unref();
        };
        const clearIdleTimer = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

        const onAbort = () => {
          clearIdleTimer();
          settleChild({ now: true });
          finish();
        };
        signal?.addEventListener?.("abort", onAbort, { once: true });
        // Registering on an already-aborted signal never fires. The gate can
        // hold a request for two minutes, so aborting during the wait — a
        // client that gave up, which is the ordinary case for a queued
        // request — left the child to run to completion holding a slot.
        if (signal?.aborted) onAbort();

        // The process already started (awaited above); this only catches a late
        // runtime error on the child handle.
        let spawnFailed = false;
        child.on("error", (err) => {
          spawnFailed = true;
          clearIdleTimer();
          freeSlot();
          // No "close" follows a handle that never really started, so the
          // request's directory has to be given back from here too.
          cleanupToolFiles();
          log?.info?.("CLAUDE-CLI", `child error: ${err.message}`);
          fail("Claude CLI failed while running on the 9Router host.", "child_error");
        });

        let stdoutBuffer = "";
        let stderrTail = "";
        let sawResult = false;

        // Runs inside a stdout listener, where a throw is an uncaught exception
        // that takes the whole server down — every other request with it — for
        // one line this version of the CLI happens to shape differently.
        const handleLine = (line) => {
          try { handleEvent(line); } catch (e) {
            log?.info?.("CLAUDE-CLI", `unreadable stream line ignored: ${e.message}`);
          }
        };

        const handleEvent = (line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed[0] !== "{") return;
          let event;
          try { event = JSON.parse(trimmed); } catch { return; }
          // The subscription's own 5h/7d windows, which the CLI reports on
          // every request. For an account whose credential the usage endpoint
          // refuses — anything from `claude setup-token` — this is the only
          // place they appear at all.
          if (event.type === "rate_limit_event") {
            recordRateLimitEvent(credentials?.providerSpecificData, event.rate_limit_info);
          }
          const { frames, finished } = translateClaudeCliEvent(event, ctx);
          for (const frame of frames) emit(frame);
          if (finished) {
            sawResult = true;
            clearIdleTimer();
            finish();
            settleChild();
          }
        };

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (data) => {
          resetIdleTimer();
          stdoutBuffer += data;
          let index;
          while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
            const line = stdoutBuffer.slice(0, index);
            stdoutBuffer = stdoutBuffer.slice(index + 1);
            handleLine(line);
          }
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (data) => {
          stderrTail = (stderrTail + data).slice(-2000);
        });

        child.on("close", (code) => {
          clearIdleTimer();
          // The relay never answers in the upstream's place, so a transport
          // failure reaches the child as a dropped connection and nothing else.
          // This is the only place it can be named.
          // Off by default, so this only speaks when someone turned it on.
          const relay = admission?.stats?.();
          if (relay) log?.info?.("CLAUDE-CLI", `cache relay ${JSON.stringify(relay)}`);
          for (const timer of exitTimers) clearTimeout(timer);
          exitTimers.length = 0;
          freeSlot();
          cleanupToolFiles();
          signal?.removeEventListener?.("abort", onAbort);
          if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
          if (closed || spawnFailed) return;
          if (!sawResult) {
            // stderr can carry config dumps and credential paths — log it, don't ship it.
            if (stderrTail.trim()) log?.info?.("CLAUDE-CLI", `stderr: ${stderrTail.trim()}`);
            fail(`Claude CLI exited with code ${code} before completing`, "exited_early");
            return;
          }
          finish();
        });

        resetIdleTimer();
        child.stdin.on("error", () => { /* child died first — close handler reports it */ });
        child.stdin.end(stdin);
      },
      // Consumer gave up on the body: stop the interpreter rather than leaking it.
      cancel() {
        if (streamTeardown) streamTeardown();
      },
    });

    return {
      response: new Response(sseStream, { status: 200, headers: SSE_HEADERS }),
      url: CLAUDE_CLI_BASE_URL,
      headers: {},
      transformedBody: {
        model,
        bin,
        stdinChars: stdin.length,
        replayedTurns: invocation.replayed ? invocation.frameCount : 0,
        conversation: invocation.shape,
      },
    };
  }
}

export default ClaudeCliExecutor;
