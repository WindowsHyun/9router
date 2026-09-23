/**
 * ClaudeCliExecutor — routes completions through the locally installed
 * Claude Code CLI (`claude -p`) instead of calling api.anthropic.com directly.
 *
 * Why: the `claude` provider drives the Anthropic OAuth endpoint with spoofed
 * CLI headers. Running the real binary keeps the traffic shape identical to an
 * ordinary Claude Code session (same client, same auth path), which removes the
 * ban risk that comes with replaying OAuth tokens from a server.
 *
 * Invocation (verified against claude 2.1.278):
 *   claude -p --output-format stream-json --verbose --include-partial-messages
 *          --model <model> --max-turns 1 --tools ""
 *          --setting-sources "" --strict-mcp-config
 *          [--system-prompt <system>]
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
 * Limitation: tool calling is not bridged — the CLI's built-in tools are off and
 * client `tools` are not exposed, so this provider is text/reasoning only.
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
  CLAUDE_CLI_IDLE_TIMEOUT_MS,
  CLAUDE_CLI_INLINE_SYSTEM_PROMPT,
  CLAUDE_CLI_MODEL_PATTERN,
  CLAUDE_CLI_DEFAULT_SYSTEM_PROMPT,
  CLAUDE_CLI_ENV_ALLOWLIST,
  CLAUDE_CLI_QUEUE_TIMEOUT_MS,
  CLAUDE_CLI_UPSTREAM_MODELS,
  claudeCliArgvBudget,
  resolveClaudeCliMaxConcurrency,
  resolveClaudeCliMaxTurns,
} from "../config/claudeCli.js";
import { createConcurrencyGate } from "../utils/concurrencyGate.js";
import {
  callerToolName,
  inertMcpServerSource,
  mcpConfigDocument,
  toMcpManifest,
} from "./claudeCliTools.js";

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
 * A `.cmd`/`.bat` shim cannot be executed directly on Windows, and running it
 * through cmd.exe is not an option: cmd has no usable escaping (`\"` is not an
 * escape there), so any argv value would be an injection vector. npm's shim sits
 * next to the package it launches, so the real entry point is spawned instead.
 */
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
// CVE-2024-27980). Route those through cmd.exe with verbatim arguments so an
// empty `--tools ""` survives instead of being dropped by the shell.
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

function blockText(part) {
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.input_text === "string") return part.input_text;
  if (part.type === "tool_use") {
    return `\n[Tool call ${part.name} id=${part.id}]\n${JSON.stringify(part.input ?? {})}\n`;
  }
  if (part.type === "tool_result") {
    const body = typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
    return `\n[Tool result id=${part.tool_use_id}]\n${body}\n`;
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
    const role = String(message.role || "user");
    let text = messageText(message);

    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = message.tool_calls.map((call) => {
        const name = call.function?.name || call.name || "tool";
        const args = call.function?.arguments ?? call.arguments ?? {};
        return `[Tool call ${name} id=${call.id}]\n${typeof args === "string" ? args : JSON.stringify(args)}`;
      });
      text = [text, ...calls].filter(Boolean).join("\n\n");
    }
    if (role === "tool") {
      const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      text = `[Tool result id=${message.tool_call_id || ""}]\n${body}`;
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
export function planClaudeCliInvocation({ model, messages, platform = process.platform, maxTurns, tools }) {
  const { system, prompt, turnsText } = buildClaudeCliPrompt(messages);
  // Advertised to the CLI through MCP, never executed here — see
  // claudeCliTools.js. It leaves the plan as data so the spawn can write it to
  // a file, which keeps this function a pure function of the request.
  const manifest = toMcpManifest(tools);
  // With tools advertised, ending the turn on the proposal IS the result, so
  // the limit is pinned to one turn no matter what the caller asked for. Given
  // another turn the CLI would go on to *invoke* the inert server, read its
  // refusal, and answer with an apology — losing the tool call the client was
  // waiting for. Without tools the caller's own limit still applies.
  const turnLimit = manifest.length ? 1 : maxTurns;
  const budget = claudeCliArgvBudget(platform);
  const inlineSystem = Boolean(system) && system.length + prompt.length > budget;

  if (!inlineSystem) {
    return {
      // Never omit --system-prompt: without it Claude Code's own agent prompt
      // applies, which is neither what an API caller asked for nor what they
      // expect to pay for.
      args: buildClaudeCliArgs({ model, system: system || CLAUDE_CLI_DEFAULT_SYSTEM_PROMPT, maxTurns: turnLimit }),
      prompt,
      inlinedSystem: false,
      manifest,
    };
  }

  return {
    args: buildClaudeCliArgs({ model, system: CLAUDE_CLI_INLINE_SYSTEM_PROMPT, maxTurns: turnLimit }),
    prompt: `[System]\n${system}\n\n${turnsText}`,
    inlinedSystem: true,
    manifest,
  };
}

/** Resolved upstream model id, or null when it is not safe to put on argv. */
export function resolveClaudeCliModel(model) {
  const upstream = CLAUDE_CLI_UPSTREAM_MODELS[model] || model;
  if (!upstream) return null;
  return CLAUDE_CLI_MODEL_PATTERN.test(upstream) ? upstream : null;
}

export function buildClaudeCliArgs({ model, system, maxTurns, mcpConfigFile }) {
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
  const upstreamModel = resolveClaudeCliModel(model);
  if (upstreamModel) args.push("--model", upstreamModel);
  if (system) args.push("--system-prompt", system);
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
  // Two ways to pin which account runs the request:
  //   configDir   — a Claude Code config directory, written by an interactive
  //                 /login. The natural choice on a desktop.
  //   oauthToken  — a long-lived token from `claude setup-token`. The only
  //                 choice in a container, where there is no terminal to sign
  //                 in with. Set last so it wins if both are present.
  const configDir = typeof account?.configDir === "string" ? account.configDir.trim() : "";
  const oauthToken = typeof account?.oauthToken === "string" ? account.oauthToken.trim() : "";
  if (configDir) child.CLAUDE_CONFIG_DIR = configDir;
  if (oauthToken) child.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return child;
}

export const __testables = { buildChildEnv };

// ─── stream-json → OpenAI chunks ─────────────────────────────────────────────

const FINISH_REASONS = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
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
export function createClaudeCliContext({ id, created, model }) {
  return {
    id,
    created,
    model,
    roleSent: false,
    stopReason: null,
    usage: null,
    // content-block index -> tool_calls index, so argument fragments land on
    // the call they belong to. Text and tool blocks share one index space.
    toolBlocks: new Map(),
    toolCount: 0,
    sawToolCall: false,
  };
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
      const call = {
        index,
        id: block.id || `call_${index}`,
        type: "function",
        // The CLI namespaces every MCP tool; the client only knows the name it
        // sent, so it gets that one back.
        function: { name: callerToolName(block.name), arguments: "" },
      };
      if (!ctx.roleSent) { ctx.roleSent = true; chunk({ role: "assistant", tool_calls: [call] }); }
      else chunk({ tool_calls: [call] });
    } else if (inner?.type === "content_block_delta") {
      const delta = inner.delta || {};
      if (delta.type === "text_delta" && delta.text) {
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
    } else if (inner?.type === "message_start" && inner.message?.usage) {
      ctx.usage = { ...ctx.usage, ...inner.message.usage };
    }
    return { frames, finished: false };
  }

  if (event?.type === "result") {
    if (!ctx.stopReason && event.stop_reason) ctx.stopReason = event.stop_reason;
    // A turn that ends by proposing a tool call always trips --max-turns: the
    // CLI is holding an unanswered call with no turn left to answer it, so it
    // reports subtype "error_max_turns" with is_error true. That is the agent
    // loop's verdict, not the completion's — the call itself is complete, and
    // running it belongs to the client that supplied the tool. Reading it as a
    // failure is what cut the stream off mid-answer for every tool-using
    // client.
    const proposedToolCall = ctx.sawToolCall && event.stop_reason === "tool_use";
    // `is_error` can otherwise ride along with subtype "success" (e.g. an
    // upstream 529 the CLI surfaced as its final text). Delivering that as
    // assistant content would hand the client a successful completion whose
    // body is an error message.
    if (!proposedToolCall && (event.subtype !== "success" || event.is_error === true)) {
      const message = event.error || event.result || `Claude CLI returned ${event.subtype}`;
      const code = event.subtype !== "success" ? event.subtype : "upstream_error";
      frames.push(sseChunk({ error: { message: String(message), type: "claude_cli_error", code } }));
      return { frames, finished: true };
    }
    if (event.usage) ctx.usage = { ...ctx.usage, ...event.usage };
    // A non-streaming fallback: emit the final text if no delta ever arrived.
    if (!ctx.roleSent && typeof event.result === "string" && event.result) {
      ctx.roleSent = true;
      chunk({ role: "assistant", content: event.result });
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
 * Write the caller's tools where the CLI can reach them.
 *
 * Per request, and in its own directory: two requests advertise different
 * tools, and the CLI starts the server when it feels like it — sharing one path
 * would let a late start pick up another request's inventory.
 *
 * Returns null when there is nothing to advertise, which is the common case and
 * spawns no MCP server at all.
 */
function writeToolManifest(manifest) {
  if (!manifest?.length) return null;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-claude-tools-"));
    // .cjs so the extension decides the module kind: a temp directory has no
    // package.json to consult, and the generated program is a plain script.
    const serverPath = path.join(dir, "inert-mcp.cjs");
    const configPath = path.join(dir, "mcp.json");
    fs.writeFileSync(serverPath, inertMcpServerSource(manifest));
    fs.writeFileSync(configPath, JSON.stringify(
      mcpConfigDocument(process.execPath, serverPath),
    ));
    return { dir, configPath };
  } catch {
    // Losing the tools is bad; failing the request over a temp file is worse.
    // The caller then gets a plain answer instead of a tool call.
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

    const invocation = planClaudeCliInvocation({ model, messages, maxTurns: b.max_turns, tools: b.tools });
    const prompt = invocation.prompt;
    // Only the binary can make a plan invalid, so this is settled before any
    // file is written — the tool files come later, once the request is going
    // to spawn.
    const basePlan = buildSpawnPlan(bin, invocation.args);
    if (basePlan.error) {
      log?.info?.("CLAUDE-CLI", basePlan.error);
      return { response: errorResponse(basePlan.error, "unsupported_binary", 503) };
    }

    log?.info?.(
      "CLAUDE-CLI",
      `claude -p → model=${model}, bin=${bin}, promptChars=${prompt.length}`
        + (invocation.manifest.length ? `, tools=${invocation.manifest.length}` : "")
        + (invocation.inlinedSystem ? " (system prompt inlined into stdin)" : ""),
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
    const toolFiles = writeToolManifest(invocation.manifest);
    // Once per request, on every path that can end it.
    //
    // Retried once, because the MCP server is a grandchild: it exits when the
    // interpreter closes its stdin, which can be a moment after the "close"
    // this runs from. Windows refuses to delete a script a live process is
    // still executing, and giving up there would leak a directory per request.
    let toolFilesRemoved = false;
    const cleanupToolFiles = (retry = true) => {
      if (!toolFiles || toolFilesRemoved) return;
      try {
        fs.rmSync(toolFiles.dir, { recursive: true, force: true });
        toolFilesRemoved = true;
      } catch {
        if (!retry) return;
        // Unref'd: this must never be the reason the process stays alive.
        const timer = setTimeout(() => cleanupToolFiles(false), 2000);
        if (timer.unref) timer.unref();
      }
    };
    const plan = toolFiles
      ? buildSpawnPlan(bin, [...invocation.args, "--mcp-config", toolFiles.configPath])
      : basePlan;

    const ctx = createClaudeCliContext({
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
        env: buildChildEnv(process.env, credentials?.providerSpecificData),
        // Never the 9Router process cwd, and never a shared temp dir — see
        // resolveSpawnCwd for why the directory has to be one we created.
        cwd: resolveSpawnCwd(),
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
        const fail = (message, code) => {
          emit(sseChunk({ error: { message, type: "claude_cli_error", code } }));
          finish();
        };

        // Exposed to cancel() below, which runs outside this closure.
        streamTeardown = () => {
          closed = true;
          killClaudeCliTree(child);
        };

        let idleTimer = null;
        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            fail(`Claude CLI produced no output for ${CLAUDE_CLI_IDLE_TIMEOUT_MS}ms`, "idle_timeout");
            killClaudeCliTree(child);
          }, CLAUDE_CLI_IDLE_TIMEOUT_MS);
          if (idleTimer.unref) idleTimer.unref();
        };
        const clearIdleTimer = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

        const onAbort = () => {
          clearIdleTimer();
          killClaudeCliTree(child);
          finish();
        };
        signal?.addEventListener?.("abort", onAbort, { once: true });

        // The process already started (awaited above); this only catches a late
        // runtime error on the child handle.
        let spawnFailed = false;
        child.on("error", (err) => {
          spawnFailed = true;
          clearIdleTimer();
          freeSlot();
          log?.info?.("CLAUDE-CLI", `child error: ${err.message}`);
          fail("Claude CLI failed while running on the 9Router host.", "child_error");
        });

        let stdoutBuffer = "";
        let stderrTail = "";
        let sawResult = false;

        const handleLine = (line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed[0] !== "{") return;
          let event;
          try { event = JSON.parse(trimmed); } catch { return; }
          const { frames, finished } = translateClaudeCliEvent(event, ctx);
          for (const frame of frames) emit(frame);
          if (finished) {
            sawResult = true;
            clearIdleTimer();
            finish();
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
        child.stdin.end(prompt);
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
      transformedBody: { model, bin, promptChars: prompt.length, inlinedSystem: invocation.inlinedSystem },
    };
  }
}

export default ClaudeCliExecutor;
