import { describe, it, expect } from "vitest";
import {
  buildClaudeCliArgs,
  buildClaudeCliPrompt,
  translateClaudeCliEvent,
  resolveClaudeBin,
  resolveClaudeCliModel,
  planClaudeCliInvocation,
  isShimPath,
  buildSpawnPlan,
  __testables,
} from "open-sse/executors/claude-cli.js";
import { getExecutor as getExecutorForGuard } from "open-sse/executors/index.js";
import {
  CLAUDE_CLI_DEFAULT_SYSTEM_PROMPT,
  resolveClaudeCliMaxTurns,
  CLAUDE_CLI_DEFAULT_MAX_TURNS,
  CLAUDE_CLI_MAX_TURNS_LIMIT,
} from "open-sse/config/claudeCli.js";
import { getExecutor } from "open-sse/executors/index.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { PROVIDER_MODELS } from "open-sse/providers/index.js";
import { parseSSEToOpenAIResponse } from "open-sse/handlers/chatCore/sseToJsonHandler.js";

const ctx = () => ({ id: "chatcmpl-x", created: 1, model: "claude-cli-haiku", roleSent: false, stopReason: null, usage: null });
const parseFrames = (frames) => frames.map((f) => JSON.parse(f.replace(/^data: /, "").trim()));

describe("claude-cli prompt building", () => {
  it("routes system messages to --system-prompt and keeps a lone user turn bare", () => {
    const { system, prompt } = buildClaudeCliPrompt([
      { role: "system", content: "You are terse." },
      { role: "user", content: "Say hi" },
    ]);
    expect(system).toBe("You are terse.");
    expect(prompt).toBe("Say hi");
  });

  it("marks roles when the conversation has history", () => {
    const { prompt } = buildClaudeCliPrompt([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ]);
    expect(prompt).toBe("[User]\nfirst\n\n[Assistant]\nsecond\n\n[User]\nthird");
  });

  it("flattens array content blocks and tool round-trips", () => {
    const { prompt } = buildClaudeCliPrompt([
      { role: "user", content: [{ type: "text", text: "look" }, { type: "text", text: "here" }] },
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
    ]);
    expect(prompt).toContain("lookhere");
    expect(prompt).toContain("[Tool call ls id=c1]");
    expect(prompt).toContain("[Tool result id=c1]\na.txt");
  });

  it("treats developer role as system", () => {
    const { system } = buildClaudeCliPrompt([{ role: "developer", content: "rules" }, { role: "user", content: "go" }]);
    expect(system).toBe("rules");
  });
});

describe("claude-cli argv", () => {
  it("disables tools, host settings and MCP, and maps model aliases", () => {
    const args = buildClaudeCliArgs({ model: "claude-cli-opus", system: "sys", maxTurns: 1 });
    expect(args).toContain("-p");
    expect(args.join(" ")).toContain("--output-format stream-json");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--strict-mcp-config");
    // "" disables all built-in tools; the empty value must survive as its own argv slot.
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("sys");
  });

  it("omits --system-prompt only when the caller explicitly passes none to the builder", () => {
    expect(buildClaudeCliArgs({ model: "claude-cli-haiku", system: "" })).not.toContain("--system-prompt");
  });

  it("passes unknown model ids through untouched", () => {
    const args = buildClaudeCliArgs({ model: "claude-opus-4-5-20251101", system: "" });
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-5-20251101");
  });
});

describe("claude-cli stream translation", () => {
  it("emits role on the first text delta only", () => {
    const c = ctx();
    const first = parseFrames(translateClaudeCliEvent({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "he" } },
    }, c).frames);
    const second = parseFrames(translateClaudeCliEvent({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "llo" } },
    }, c).frames);
    expect(first[0].choices[0].delta).toEqual({ role: "assistant", content: "he" });
    expect(second[0].choices[0].delta).toEqual({ content: "llo" });
  });

  it("maps thinking deltas to reasoning_content", () => {
    const frames = parseFrames(translateClaudeCliEvent({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
    }, ctx()).frames);
    expect(frames[0].choices[0].delta.reasoning_content).toBe("hmm");
  });

  it("finishes on result and reports aggregated usage", () => {
    const c = ctx();
    translateClaudeCliEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } }, c);
    translateClaudeCliEvent({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } }, c);
    const { frames, finished } = translateClaudeCliEvent({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
    }, c);
    const parsed = parseFrames(frames);
    expect(finished).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].choices[0].finish_reason).toBe("stop");
    // Usage must ride the finish chunk. On a separate choice-less frame the
    // passthrough injects a body-size estimate onto the finish chunk first and
    // mergeUsage keeps the larger of the two, over-reporting every request.
    expect(parsed[0].usage).toEqual({ prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 });
  });

  it("maps max_tokens stop reason to length", () => {
    const c = ctx();
    translateClaudeCliEvent({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "max_tokens" } } }, c);
    const parsed = parseFrames(translateClaudeCliEvent({ type: "result", subtype: "success" }, c).frames);
    expect(parsed[0].choices[0].finish_reason).toBe("length");
  });

  it("falls back to result text when no delta was streamed", () => {
    const parsed = parseFrames(translateClaudeCliEvent({ type: "result", subtype: "success", result: "done" }, ctx()).frames);
    expect(parsed[0].choices[0].delta).toEqual({ role: "assistant", content: "done" });
  });

  it("surfaces a non-success result as an error frame", () => {
    const { frames, finished } = translateClaudeCliEvent({ type: "result", subtype: "error_max_turns" }, ctx());
    expect(finished).toBe(true);
    expect(parseFrames(frames)[0].error.code).toBe("error_max_turns");
  });

  // An upstream failure can arrive as subtype "success" + is_error, and must not
  // be handed to the client as a completed answer whose text is an error.
  it("treats is_error on a success result as an error, not as content", () => {
    const { frames, finished } = translateClaudeCliEvent(
      { type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded" },
      ctx(),
    );
    const parsed = parseFrames(frames);
    expect(finished).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].error.code).toBe("upstream_error");
    expect(parsed[0].error.message).toContain("529");
  });

  it("ignores hook/system noise", () => {
    expect(translateClaudeCliEvent({ type: "system", subtype: "hook_started" }, ctx()).frames).toHaveLength(0);
  });
});

describe("claude-cli registration", () => {
  it("is wired into the provider registry and executor map", () => {
    expect(PROVIDERS["claude-cli"].baseUrl).toBe("claude-cli://stdio");
    expect(PROVIDERS["claude-cli"].forceStream).toBe(true);
    expect(getExecutor("claude-cli").getProvider()).toBe("claude-cli");
    expect(PROVIDER_MODELS["ccli"].map((m) => m.id)).toContain("claude-cli-sonnet");
  });

  it("resolves a binary path without throwing", () => {
    expect(typeof resolveClaudeBin()).toBe("string");
  });
});

// forceStream:true means a non-streaming client gets this SSE folded back into a
// single Chat Completion by the pipeline. Drive that with the real converter.
describe("claude-cli non-streaming conversion", () => {
  const render = (events) => {
    const c = ctx();
    return events.flatMap((event) => translateClaudeCliEvent(event, c).frames).join("") + "data: [DONE]\n\n";
  };

  it("folds the stream into one chat.completion with reasoning and usage", () => {
    const sse = render([
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "pondering" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
      { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
      { type: "result", subtype: "success", usage: { input_tokens: 12, output_tokens: 4 } },
    ]);

    const json = parseSSEToOpenAIResponse(sse, "claude-cli-haiku");
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("hello");
    expect(json.choices[0].message.reasoning_content).toBe("pondering");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
  });

  it("surfaces an executor error frame as an error result", () => {
    const sse = render([{ type: "result", subtype: "error_during_execution" }]);
    expect(parseSSEToOpenAIResponse(sse, "claude-cli-haiku").error.type).toBe("claude_cli_error");
  });
});

// Windows caps a command line at 32,767 chars, and a coding agent's system
// prompt runs well past it — measured on claude 2.1.278, 30k on argv works and
// 40k dies with ENAMETOOLONG. It used to be swapped for a stub and pasted into
// the prompt at that size; it now goes to a file, so size stops mattering and
// the caller's instructions arrive intact either way.
describe("claude-cli system prompt", () => {
  const bigSystem = "S".repeat(40000);

  // Without an explicit system prompt the CLI applies Claude Code's own agent
  // prompt: measured 8,385 prompt tokens for a one-line request versus 429 with
  // one, plus a coding-agent persona an API caller never asked for.
  it("always carries a system prompt, even when the request has no system message", () => {
    const plan = planClaudeCliInvocation({
      model: "claude-cli-haiku",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(plan.system).toBe(CLAUDE_CLI_DEFAULT_SYSTEM_PROMPT);
    expect(plan.system.length).toBeGreaterThan(0);
  });

  it("prefers the caller's system message over the default", () => {
    const plan = planClaudeCliInvocation({
      model: "claude-cli-haiku",
      messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "hi" }],
    });
    expect(plan.system).toBe("Be terse.");
  });

  it("keeps an oversized system prompt off argv, whole", () => {
    const plan = planClaudeCliInvocation({
      model: "claude-cli-haiku",
      messages: [{ role: "system", content: bigSystem }, { role: "user", content: "hi" }],
    });
    // The executor writes this to a file and passes --system-prompt-file.
    expect(plan.system).toBe(bigSystem);
    expect(plan.args).not.toContain(bigSystem);
    expect(plan.args).not.toContain("--system-prompt");
    // ...and it is no longer smuggled into the turn either.
    expect(plan.stdin).not.toContain(bigSystem);
  });

  it("puts the system prompt on argv only when asked to directly", () => {
    const args = buildClaudeCliArgs({ model: "claude-cli-haiku", system: "sys" });
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("sys");
    const fromFile = buildClaudeCliArgs({ model: "claude-cli-haiku", systemPromptFile: "/tmp/system.md" });
    expect(fromFile[fromFile.indexOf("--system-prompt-file") + 1]).toBe("/tmp/system.md");
    expect(fromFile).not.toContain("--system-prompt");
  });

  
  it("identifies .cmd/.bat shims, which cannot be executed directly", () => {
    expect(isShimPath("C:/npm/claude.cmd", "win32")).toBe(true);
    expect(isShimPath("C:/npm/claude.bat", "win32")).toBe(true);
    expect(isShimPath("C:/.local/bin/claude.exe", "win32")).toBe(false);
    expect(isShimPath("/usr/local/bin/claude", "linux")).toBe(false);
  });
});

// cmd.exe has no usable escaping, so any argv value crossing it would be an
// injection vector. The executor must never build a shell command line.
describe("claude-cli never spawns through a shell", () => {
  it("spawns a real executable directly with an argv array", () => {
    const plan = buildSpawnPlan("/usr/local/bin/claude", ["-p", "--tools", ""]);
    expect(plan.command).toBe("/usr/local/bin/claude");
    expect(plan.args).toEqual(["-p", "--tools", ""]);
    expect(plan.options.shell).toBeUndefined();
    expect(plan.options.windowsVerbatimArguments).toBeUndefined();
  });

  it("refuses a .cmd shim it cannot resolve instead of handing it to cmd.exe", () => {
    const plan = buildSpawnPlan("C:/nope/npm/claude.cmd", ["-p"]);
    expect(plan.command).toBeUndefined();
    expect(plan.error).toContain("CLI_CLAUDE_BIN");
  });

  it("never names a shell as the command", () => {
    for (const bin of ["C:/npm/claude.cmd", "C:/npm/claude.bat", "C:/bin/claude.exe", "/usr/bin/claude"]) {
      const plan = buildSpawnPlan(bin, ["-p"]);
      const command = String(plan.command || "").toLowerCase();
      expect(command).not.toContain("cmd.exe");
      expect(command).not.toContain("powershell");
      expect(command).not.toContain("/bin/sh");
    }
  });
});

// max_turns arrives on the request body; unchecked it reached argv verbatim.
describe("claude-cli max_turns is bounded", () => {
  it("accepts sane integers within the limit", () => {
    expect(resolveClaudeCliMaxTurns(1)).toBe(1);
    expect(resolveClaudeCliMaxTurns(CLAUDE_CLI_MAX_TURNS_LIMIT)).toBe(CLAUDE_CLI_MAX_TURNS_LIMIT);
  });

  it("falls back to the default for anything else", () => {
    const bad = [0, -1, 1.5, "3; whoami", '1"" & calc.exe & rem "', "abc", null, undefined, {}, [], Infinity, NaN,
      CLAUDE_CLI_MAX_TURNS_LIMIT + 1];
    for (const value of bad) {
      expect(resolveClaudeCliMaxTurns(value)).toBe(CLAUDE_CLI_DEFAULT_MAX_TURNS);
    }
  });

  it("keeps an injected max_turns out of argv entirely", () => {
    const args = buildClaudeCliArgs({ model: "claude-cli-haiku", system: "", maxTurns: '1"" & calc.exe & rem "' });
    expect(args[args.indexOf("--max-turns") + 1]).toBe(String(CLAUDE_CLI_DEFAULT_MAX_TURNS));
    expect(args.join(" ")).not.toContain("calc.exe");
  });
});

// The child is a subprocess of the gateway: process.env holds the server's
// signing secrets and every stored provider key.
describe("claude-cli child environment", () => {
  it("passes through only allowlisted variables", () => {
    const env = __testables.buildChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      JWT_SECRET: "super-secret",
      API_KEY_SECRET: "another-secret",
      MACHINE_ID_SALT: "salt",
      INITIAL_PASSWORD: "pw",
      OPENAI_API_KEY: "sk-leak",
      ANTHROPIC_API_KEY: "sk-ant-leak",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:20128",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    for (const leaked of ["JWT_SECRET", "API_KEY_SECRET", "MACHINE_ID_SALT", "INITIAL_PASSWORD",
      "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) {
      expect(env[leaked]).toBeUndefined();
    }
  });
});

// `--model` is request-controlled (passthroughModels) and on the .cmd path it
// reaches cmd.exe, so only a conservative character set may pass.
describe("claude-cli model validation", () => {
  it("accepts real model ids and aliases", () => {
    expect(resolveClaudeCliModel("claude-cli-opus")).toBe("opus");
    expect(resolveClaudeCliModel("claude-opus-4-5-20251101")).toBe("claude-opus-4-5-20251101");
    expect(resolveClaudeCliModel("claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
  });

  it("rejects shell metacharacters and oversized ids", () => {
    for (const bad of ['haiku" & calc.exe & "', "haiku|whoami", "haiku;id", "haiku `id`", "a".repeat(81), ""]) {
      expect(resolveClaudeCliModel(bad)).toBe(null);
    }
  });

  // `--model --foo` makes commander treat the value as missing and re-parse the
  // rest of argv, which would smuggle a real flag into the child.
  it("rejects a model id that is really a CLI flag", () => {
    for (const bad of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "-p", "--settings"]) {
      expect(resolveClaudeCliModel(bad)).toBe(null);
    }
  });

  it("refuses to spawn for an unsafe model and reports it as an error frame", async () => {
    const { response } = await getExecutorForGuard("claude-cli").execute({
      model: 'haiku" & calc.exe & "',
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const text = await response.text();
    const frame = JSON.parse(text.split("\n\n")[0].replace(/^data: /, ""));
    expect(frame.error.code).toBe("invalid_model");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});

/**
 * The routed model list was partly invented: it offered five generic rows, and
 * omitted opusplan and the 1M-context variants entirely. Every id below was
 * checked against the installed Claude Code (2.1.278) — an alias it does not
 * know is refused with "isn't described by this version's model catalog".
 */
describe("claude-cli exposes the models the CLI actually accepts", () => {
  const REGISTERED = {
    "claude-cli-default": "default",
    "claude-cli-opus": "opus",
    "claude-cli-opus-1m": "opus[1m]",
    "claude-cli-opusplan": "opusplan",
    "claude-cli-sonnet": "sonnet",
    "claude-cli-sonnet-1m": "sonnet[1m]",
    "claude-cli-haiku": "haiku",
    "claude-cli-fable": "fable",
  };

  it.each(Object.entries(REGISTERED))("%s → claude --model %s", (routed, upstream) => {
    expect(resolveClaudeCliModel(routed)).toBe(upstream);
  });

  it("puts the 1M variants on argv with their brackets intact", () => {
    // CLAUDE_CLI_MODEL_PATTERN has to admit "[" and "]" or the 1M window is
    // unreachable — the CLI's own wording is "/model sonnet[1m]".
    const args = buildClaudeCliArgs({ model: "claude-cli-sonnet-1m", system: "s" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet[1m]");
  });

  it("offers opusplan, which Claude Code treats as a mode rather than a model", () => {
    expect(resolveClaudeCliModel("claude-cli-opusplan")).toBe("opusplan");
  });

  it("declares the 1M rows with a 1M context window, not 200k", async () => {
    const registry = await import("open-sse/providers/registry/claude-cli.js");
    const models = registry.default?.models || registry.models;
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["claude-cli-sonnet-1m"].contextLength).toBe(1_000_000);
    expect(byId["claude-cli-opus-1m"].contextLength).toBe(1_000_000);
    expect(byId["claude-cli-opus"].contextLength).toBe(200_000);
  });

  it("registers exactly the ids it maps — no row without a mapping", async () => {
    const registry = await import("open-sse/providers/registry/claude-cli.js");
    const models = registry.default?.models || registry.models;
    for (const { id } of models) {
      expect(resolveClaudeCliModel(id), `${id} has no upstream mapping`).toBeTruthy();
    }
    expect(models.map((m) => m.id).sort()).toEqual(Object.keys(REGISTERED).sort());
  });
});
