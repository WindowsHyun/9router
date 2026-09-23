import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildClaudeCliArgs,
  createClaudeCliContext,
  planClaudeCliInvocation,
  translateClaudeCliEvent,
} from "open-sse/executors/claude-cli.js";
import {
  callerToolName,
  inertMcpServerSource,
  mcpConfigDocument,
  toMcpManifest,
} from "open-sse/executors/claudeCliTools.js";
import { CLAUDE_CLI_MCP_TOOL_PREFIX } from "open-sse/config/claudeCli.js";

/**
 * Tool calling through the Claude Code CLI.
 *
 * The route used to drop the caller's tools on the floor, so an agentic client
 * sent tools, got prose, and waited forever for a call that could not arrive.
 * Claude Code only proposes a tool it can see, and the only way to show it one
 * that is not built in is MCP — hence an inert server that advertises the
 * caller's inventory and executes nothing.
 *
 * The second half is the stream: a turn that ends on a proposal always trips
 * `--max-turns`, which the CLI reports as an error, and reading that as failure
 * cut the response off mid-flight.
 */

const TMP = path.join(os.tmpdir(), `9r-cli-tools-unit-${Date.now()}`);
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const OPENAI_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

describe("toMcpManifest", () => {
  it("takes the OpenAI tool dialect", () => {
    expect(toMcpManifest([OPENAI_TOOL])).toEqual([{
      name: "get_weather",
      description: "Get the weather.",
      inputSchema: OPENAI_TOOL.function.parameters,
    }]);
  });

  it("takes the Claude dialect too, because either can reach this executor", () => {
    const manifest = toMcpManifest([
      { name: "search", description: "Search.", input_schema: { type: "object", properties: {} } },
    ]);
    expect(manifest[0].name).toBe("search");
    expect(manifest[0].inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("gives a schemaless tool an object schema, which the CLI requires", () => {
    const manifest = toMcpManifest([{ type: "function", function: { name: "ping" } }]);
    expect(manifest[0].inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("drops a duplicate name rather than making the call back ambiguous", () => {
    expect(toMcpManifest([OPENAI_TOOL, OPENAI_TOOL])).toHaveLength(1);
  });

  it("drops a name that would not survive the CLI's namespacing", () => {
    expect(toMcpManifest([{ type: "function", function: { name: "bad name!" } }])).toEqual([]);
    expect(toMcpManifest([{ type: "function", function: { name: "" } }])).toEqual([]);
  });

  it("treats anything that is not a list as no tools", () => {
    expect(toMcpManifest(undefined)).toEqual([]);
    expect(toMcpManifest("tools")).toEqual([]);
  });
});

describe("callerToolName", () => {
  it("strips the namespace the CLI adds to every MCP tool", () => {
    expect(callerToolName(`${CLAUDE_CLI_MCP_TOOL_PREFIX}get_weather`)).toBe("get_weather");
  });

  it("leaves a name that was never namespaced alone", () => {
    expect(callerToolName("Read")).toBe("Read");
    expect(callerToolName("")).toBe("");
  });
});

describe("the generated MCP server", () => {
  const manifest = toMcpManifest([OPENAI_TOOL]);

  /** Speak JSON-RPC to the real generated program, the way the CLI does. */
  const ask = (requests) => new Promise((resolve, reject) => {
    fs.mkdirSync(TMP, { recursive: true });
    const file = path.join(TMP, `server-${Math.random().toString(36).slice(2)}.cjs`);
    fs.writeFileSync(file, inertMcpServerSource(manifest));
    const child = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", () => {
      if (err.trim()) return reject(new Error(err.trim().slice(0, 300)));
      resolve(out.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    });
    child.stdin.end(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  });

  it("answers initialize and lists exactly the caller's tools", async () => {
    const [init, list] = await ask([
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(init.result.capabilities).toEqual({ tools: {} });
    expect(list.result.tools).toEqual(manifest);
  });

  it("refuses to run one, so a model that tries gets an answer and not a hang", async () => {
    const [called] = await ask([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_weather" } },
    ]);
    expect(called.result.isError).toBe(true);
    expect(called.result.content[0].text).toMatch(/inert/i);
  });

  it("says nothing back to a notification, which carries no id", async () => {
    const replies = await ask([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 7, method: "tools/list" },
    ]);
    expect(replies).toHaveLength(1);
    expect(replies[0].id).toBe(7);
  });

  it("survives a malformed line instead of dying on it", async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const file = path.join(TMP, "server-malformed.cjs");
    fs.writeFileSync(file, inertMcpServerSource(manifest));
    const replies = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.on("error", reject);
      child.on("close", () => resolve(out.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
      child.stdin.end(`not json\n${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
    });
    expect(replies).toHaveLength(1);
    expect(replies[0].id).toBe(3);
  });
});

describe("mcpConfigDocument", () => {
  it("points the CLI at the generated server with this server's own node", () => {
    const doc = mcpConfigDocument("/usr/bin/node", "/tmp/x/inert-mcp.cjs");
    const server = Object.values(doc.mcpServers)[0];
    expect(server.command).toBe("/usr/bin/node");
    expect(server.args).toEqual(["/tmp/x/inert-mcp.cjs"]);
  });
});

describe("buildClaudeCliArgs", () => {
  it("never leaves the CLI waiting for a human", () => {
    const args = buildClaudeCliArgs({ model: "claude-cli-haiku" });
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
  });

  it("adds the MCP config only when there is one", () => {
    expect(buildClaudeCliArgs({ model: "claude-cli-haiku" })).not.toContain("--mcp-config");
    const withTools = buildClaudeCliArgs({ model: "claude-cli-haiku", mcpConfigFile: "/tmp/mcp.json" });
    expect(withTools[withTools.indexOf("--mcp-config") + 1]).toBe("/tmp/mcp.json");
  });
});

describe("planClaudeCliInvocation", () => {
  it("carries the tools out as a manifest for the spawn to write", () => {
    const plan = planClaudeCliInvocation({
      model: "claude-cli-haiku",
      messages: [{ role: "user", content: "hi" }],
      tools: [OPENAI_TOOL],
    });
    expect(plan.manifest).toHaveLength(1);
    expect(plan.manifest[0].name).toBe("get_weather");
  });

  it("pins the turn limit to one when tools are advertised", () => {
    // A second turn lets the CLI invoke the inert server, read its refusal and
    // answer with an apology — the client never sees the call it was waiting
    // for. The caller does not get to raise that.
    const plan = planClaudeCliInvocation({
      model: "claude-cli-haiku",
      messages: [{ role: "user", content: "hi" }],
      tools: [OPENAI_TOOL],
      maxTurns: 5,
    });
    expect(plan.args[plan.args.indexOf("--max-turns") + 1]).toBe("1");
  });

  it("leaves the caller's turn limit alone when there are no tools", () => {
    const plan = planClaudeCliInvocation({
      model: "claude-cli-haiku",
      messages: [{ role: "user", content: "hi" }],
      maxTurns: 5,
    });
    expect(plan.args[plan.args.indexOf("--max-turns") + 1]).toBe("5");
  });

  it("reports no manifest for a request with no tools, so nothing extra spawns", () => {
    const plan = planClaudeCliInvocation({
      model: "claude-cli-haiku",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(plan.manifest).toEqual([]);
  });
});

describe("translating a proposed tool call", () => {
  let ctx;
  beforeEach(() => { ctx = createClaudeCliContext({ id: "chatcmpl-x", created: 1, model: "m" }); });

  const streamEvent = (event) => translateClaudeCliEvent({ type: "stream_event", event }, ctx);
  const deltasOf = (frames) => frames
    .map((f) => { try { return JSON.parse(f.replace(/^data: /, "").trim()); } catch { return null; } })
    .filter(Boolean)
    .map((f) => f.choices?.[0]?.delta)
    .filter(Boolean);

  const openCall = (index = 1, name = `${CLAUDE_CLI_MCP_TOOL_PREFIX}get_weather`) => streamEvent({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id: "toolu_1", name, input: {} },
  });

  it("opens the call as soon as the block starts, under the caller's own name", () => {
    const [delta] = deltasOf(openCall().frames);
    expect(delta.role).toBe("assistant");
    expect(delta.tool_calls[0]).toMatchObject({
      index: 0,
      id: "toolu_1",
      type: "function",
      function: { name: "get_weather", arguments: "" },
    });
  });

  it("streams the argument fragments onto that call", () => {
    openCall();
    const frames = [
      streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } }),
      streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Seoul"}' } }),
    ].flatMap((r) => r.frames);
    const joined = deltasOf(frames).map((d) => d.tool_calls[0].function.arguments).join("");
    expect(JSON.parse(joined)).toEqual({ city: "Seoul" });
    expect(deltasOf(frames).every((d) => d.tool_calls[0].index === 0)).toBe(true);
  });

  it("keeps two calls apart by the block they came from", () => {
    openCall(1, `${CLAUDE_CLI_MCP_TOOL_PREFIX}get_weather`);
    openCall(2, `${CLAUDE_CLI_MCP_TOOL_PREFIX}search`);
    const first = deltasOf(streamEvent({
      type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "a" },
    }).frames)[0];
    const second = deltasOf(streamEvent({
      type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "b" },
    }).frames)[0];
    expect(first.tool_calls[0].index).toBe(0);
    expect(second.tool_calls[0].index).toBe(1);
  });

  it("ignores a fragment for a block that never opened a call", () => {
    const { frames } = streamEvent({
      type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: "x" },
    });
    expect(frames).toEqual([]);
  });

  it("still streams text and thinking the way it always did", () => {
    const text = deltasOf(streamEvent({
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" },
    }).frames)[0];
    expect(text).toMatchObject({ role: "assistant", content: "hello" });
    const thinking = deltasOf(streamEvent({
      type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" },
    }).frames)[0];
    expect(thinking.reasoning_content).toBe("hmm");
  });
});

describe("the result event after a tool call", () => {
  let ctx;
  beforeEach(() => { ctx = createClaudeCliContext({ id: "chatcmpl-x", created: 1, model: "m" }); });

  const parsed = (frames) => frames
    .map((f) => { try { return JSON.parse(f.replace(/^data: /, "").trim()); } catch { return null; } })
    .filter(Boolean);

  // The exact result the CLI sends when a turn ends by proposing a call.
  const MAX_TURNS_ON_TOOL = {
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    stop_reason: "tool_use",
    num_turns: 2,
  };

  it("is a completion, not an error: the call is what the client asked for", () => {
    ctx.sawToolCall = true;
    ctx.stopReason = "tool_use";
    const { frames, finished } = translateClaudeCliEvent(MAX_TURNS_ON_TOOL, ctx);
    expect(finished).toBe(true);
    const events = parsed(frames);
    expect(events.some((e) => e.error)).toBe(false);
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("is still an error when the turns ran out with no call to show for it", () => {
    const { frames } = translateClaudeCliEvent(
      { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2 },
      ctx,
    );
    expect(parsed(frames)[0].error.code).toBe("error_max_turns");
  });

  it("still refuses to pass off an upstream failure as an answer", () => {
    const { frames } = translateClaudeCliEvent(
      { type: "result", subtype: "success", is_error: true, result: "Overloaded" },
      ctx,
    );
    expect(parsed(frames)[0].error.message).toBe("Overloaded");
  });

  it("takes the stop reason from the result when no message_delta carried one", () => {
    ctx.sawToolCall = true;
    const { frames } = translateClaudeCliEvent(MAX_TURNS_ON_TOOL, ctx);
    expect(parsed(frames).at(-1).choices[0].finish_reason).toBe("tool_calls");
  });
});
