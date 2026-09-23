/**
 * Tool calling through the Claude Code CLI, end to end.
 *
 *   node scripts/fork/check-claude-cli-tools-live.mjs
 *
 * The report: "output stops mid-stream, data cuts off, calling it from the CLI
 * just hangs". The cause was that this route dropped the caller's tools
 * entirely. An agentic client — Claude Code itself, or anything else that sends
 * a `tools` array — sends its tools, gets prose back, and waits for a tool call
 * that can never arrive.
 *
 * Underneath that sat a second failure. Claude Code only proposes a tool it can
 * see, so the tools are advertised through an inert MCP server; but a turn that
 * ends on a proposal always trips `--max-turns`, and the CLI reports that as
 * `subtype: "error_max_turns", is_error: true`. Reading it as a failure turned
 * every tool call into an error frame halfway through the stream.
 *
 * So this asserts the whole round trip, in both stream modes:
 *   1. a request with tools comes back as tool_calls, with the caller's own
 *      tool name and arguments that parse;
 *   2. the same over SSE, arriving as deltas and finishing as tool_calls;
 *   3. the tool result goes back and produces a final answer;
 *   4. a request with no tools still answers in plain text;
 *   5. the same through /v1/messages, because a Claude Code client speaks the
 *      Anthropic dialect and its calls have to arrive as tool_use blocks.
 *
 * It runs the production build on purpose. The generated MCP server was once
 * addressed through `import.meta.url`, which the bundler rewrites — that
 * failure only appears when a bundler is involved, so the artifact that ships
 * is the one worth checking.
 *
 * It spends eight small Claude requests on whatever account this machine is
 * signed into. Skips when Claude Code is missing or not signed in, or when
 * there is no build to run.
 *
 * Needs port 21995 free.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = process.env.ROUTER_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 21995;
const PASSWORD = "claude-cli-tools-password";
const DATA_DIR = path.join(os.tmpdir(), `9r-cli-tools-${Date.now()}`);
const MODEL = "claude-cli/claude-cli-haiku";

const TOOLS = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
}];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

const call = (opts, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, timeout: 300000, ...opts }, (res) => {
    let data = "";
    res.on("data", (c) => { data += c; });
    res.on("end", () => {
      let json = null;
      try { json = JSON.parse(data); } catch { /* sse or html */ }
      resolve({ status: res.statusCode, headers: res.headers, body: data, json });
    });
  });
  r.on("error", reject);
  r.on("timeout", () => r.destroy(new Error("request timeout")));
  if (body) r.write(body);
  r.end();
});

const waitFor = async (fn, ms, label) => {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${label} (${last})`);
};

/** SSE `data:` payloads, in order, with the terminator dropped. */
function sseEvents(body) {
  return body.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => { try { return JSON.parse(payload); } catch { return null; } })
    .filter(Boolean);
}

let server;
let log = "";
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const env = { ...process.env };
  delete env.JWT_SECRET;
  if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    console.log("  SKIP  tool calling (no production build — run `npx next build` first)");
    process.exit(0);
  }
  server = spawn(process.execPath,
    [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "--port", String(PORT)], {
      cwd: ROOT,
      env: {
        ...env, DATA_DIR, INITIAL_PASSWORD: PASSWORD, PORT: String(PORT),
        NODE_OPTIONS: `--require "${path.join(ROOT, "custom-server.js").replace(/\\/g, "/")}"`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });

  await waitFor(async () => (await call({ method: "GET", path: "/api/health" })).status < 500,
    240000, "the built server to answer");

  const login = await call({ method: "POST", path: "/api/auth/login", headers: { "content-type": "application/json" } },
    JSON.stringify({ password: PASSWORD }));
  const m = /auth_token=([^;]+)/.exec([].concat(login.headers["set-cookie"] || []).join("; "));
  if (!m) throw new Error("no session cookie from login");
  const cookie = `auth_token=${m[1]}`;
  const json = { cookie, "content-type": "application/json" };

  const accounts = await call({ method: "GET", path: "/api/cli-tools/claude-cli-accounts", headers: { cookie } });
  // A 200 that simply reports no Claude Code is a genuine skip. Anything else
  // is the server failing, and skipping on that would hide the failure this
  // check exists to catch.
  if (accounts.status !== 200 || !accounts.json) {
    throw new Error(`accounts endpoint returned ${accounts.status}: ${accounts.body.slice(0, 400)}`);
  }
  if (!accounts.json.installed || !accounts.json.host?.signedIn) {
    console.log(`  SKIP  tool calling (installed=${accounts.json.installed} `
      + `hostSignedIn=${accounts.json.host?.signedIn})`);
    process.exit(0);
  }
  const adopted = await call({ method: "POST", path: "/api/cli-tools/claude-cli-accounts", headers: json },
    JSON.stringify({ adoptHost: true }));
  if (!adopted.json?.account?.id) throw new Error(`cannot adopt host account: ${adopted.body.slice(0, 200)}`);

  const keyRes = await call({ method: "POST", path: "/api/keys", headers: json },
    JSON.stringify({ name: "claude-cli-tools-check" }));
  const apiKey = keyRes.json?.apiKey?.key || keyRes.json?.key || keyRes.json?.apiKey;
  if (!apiKey) throw new Error(`no API key: ${keyRes.body.slice(0, 200)}`);

  const complete = (payload) => call({
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  }, JSON.stringify(payload));

  const ASK = { role: "user", content: "What is the weather in Seoul? Use the tool." };

  // 1. Buffered: the shape an OpenAI client reads when it does not stream.
  const buffered = await complete({ model: MODEL, messages: [ASK], tools: TOOLS, stream: false });
  const message = buffered.json?.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.[0];
  check("a request carrying tools comes back as a tool call, not prose",
    buffered.status === 200 && Boolean(toolCall),
    `status=${buffered.status} body=${buffered.body.slice(0, 400)}`);
  check("...named the way the caller named it, with no MCP prefix",
    toolCall?.function?.name === "get_weather",
    `name=${toolCall?.function?.name}`);
  check("...with arguments that parse, carrying what was asked for",
    (() => {
      try { return JSON.parse(toolCall?.function?.arguments || "{}").city?.toLowerCase().includes("seoul"); }
      catch { return false; }
    })(),
    `arguments=${toolCall?.function?.arguments}`);
  check("...and finish_reason says a tool call is what ended the turn",
    buffered.json?.choices?.[0]?.finish_reason === "tool_calls",
    `finish_reason=${buffered.json?.choices?.[0]?.finish_reason}`);
  // The regression this check exists for: error_max_turns reaching the client.
  check("no error frame rides along with the call",
    !/error_max_turns|claude_cli_error/.test(buffered.body),
    buffered.body.slice(0, 400));

  // 2. Streamed: the same call, as deltas.
  const streamed = await complete({ model: MODEL, messages: [ASK], tools: TOOLS, stream: true });
  const events = sseEvents(streamed.body);
  const opening = events.find((e) => e.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name);
  const argumentText = events
    .flatMap((e) => e.choices?.[0]?.delta?.tool_calls || [])
    .map((c) => c.function?.arguments || "")
    .join("");
  check("streaming delivers the call as deltas",
    Boolean(opening) && opening.choices[0].delta.tool_calls[0].function.name === "get_weather",
    `events=${events.length} body=${streamed.body.slice(0, 400)}`);
  check("...whose argument fragments join into valid JSON",
    (() => { try { return Boolean(JSON.parse(argumentText).city); } catch { return false; } })(),
    `joined=${argumentText}`);
  check("...and the stream finishes as tool_calls, then terminates",
    events.some((e) => e.choices?.[0]?.finish_reason === "tool_calls") && streamed.body.includes("[DONE]"),
    streamed.body.slice(-300));
  check("...with no error frame anywhere in it",
    !/claude_cli_error/.test(streamed.body),
    streamed.body.slice(0, 400));

  // 3. The round trip: the client runs the tool and sends the result back.
  const followUp = await complete({
    model: MODEL,
    tools: TOOLS,
    stream: false,
    messages: [
      ASK,
      { role: "assistant", content: "", tool_calls: [toolCall] },
      { role: "tool", tool_call_id: toolCall?.id, content: '{"city":"Seoul","temp_c":21,"sky":"clear"}' },
    ],
  });
  const answer = followUp.json?.choices?.[0]?.message?.content || "";
  check("the tool result comes back as a final answer",
    followUp.status === 200 && /21|clear/i.test(answer),
    `status=${followUp.status} content=${answer.slice(0, 200)} body=${followUp.body.slice(0, 300)}`);

  // 4. A caller that raises max_turns must still get its call back. With tools
  //    advertised, a second turn lets the CLI invoke the inert server, read the
  //    refusal, and answer with an apology — losing the call entirely.
  const raised = await complete({ model: MODEL, messages: [ASK], tools: TOOLS, max_turns: 5, stream: false });
  check("raising max_turns does not swallow the tool call",
    raised.json?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === "get_weather",
    `finish=${raised.json?.choices?.[0]?.finish_reason} `
      + `content=${(raised.json?.choices?.[0]?.message?.content || "").slice(0, 200)}`);

  // 5. Tools offered but not needed: the answer is text, and nothing errors.
  const unused = await complete({
    model: MODEL,
    messages: [{ role: "user", content: "Reply with the single word: ok. Do not use any tool." }],
    tools: TOOLS,
    stream: false,
  });
  check("a question that needs no tool still answers in text",
    unused.status === 200 && /ok/i.test(unused.json?.choices?.[0]?.message?.content || "")
      && !/claude_cli_error/.test(unused.body),
    `status=${unused.status} body=${unused.body.slice(0, 300)}`);

  // 6. No tools: the path that already worked must keep working.
  const plain = await complete({
    model: MODEL,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    stream: false,
  });
  check("a request with no tools still answers in plain text",
    plain.status === 200 && /ok/i.test(plain.json?.choices?.[0]?.message?.content || ""),
    `status=${plain.status} body=${plain.body.slice(0, 300)}`);
  check("...and proposes no tool call of its own",
    !plain.json?.choices?.[0]?.message?.tool_calls?.length,
    JSON.stringify(plain.json?.choices?.[0]?.message || {}).slice(0, 200));
  // 6b. History has to arrive as history. Replayed turns go in as real frames
  //     the CLI acknowledges without calling the model; a transcript pasted
  //     into one prompt would also "work", so this asks for something only the
  //     earlier turn can supply.
  const recall = await complete({
    model: MODEL,
    stream: false,
    messages: [
      { role: "user", content: "Remember the number 4271. Reply with just: ok" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "What number did I ask you to remember? Reply with only the digits." },
    ],
  });
  check("an earlier turn is still there on the next request",
    /4271/.test(recall.json?.choices?.[0]?.message?.content || ""),
    `status=${recall.status} content=${(recall.json?.choices?.[0]?.message?.content || "").slice(0, 200)}`);

  // 7. The Anthropic dialect, which is what a Claude Code client actually
  //    speaks. It reaches the same executor through a different translator, so
  //    a call that works as OpenAI tool_calls can still be lost on the way back
  //    out as a tool_use block.
  const anthropic = (payload) => call({
    method: "POST",
    path: "/v1/messages",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  }, JSON.stringify(payload));

  const ANTHROPIC_TOOLS = [{
    name: "get_weather",
    description: "Get the current weather for a city.",
    input_schema: TOOLS[0].function.parameters,
  }];

  const messages = await anthropic({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: "What is the weather in Seoul? Use the tool." }],
    tools: ANTHROPIC_TOOLS,
    stream: false,
  });
  const block = (messages.json?.content || []).find((c) => c.type === "tool_use");
  check("a Claude-dialect request gets its call back as a tool_use block",
    messages.status === 200 && Boolean(block),
    `status=${messages.status} body=${messages.body.slice(0, 400)}`);
  check("...under the caller's own tool name, with the input it asked for",
    block?.name === "get_weather" && /seoul/i.test(JSON.stringify(block?.input || {})),
    `name=${block?.name} input=${JSON.stringify(block?.input)}`);
  check("...and stop_reason says a tool call ended the turn",
    messages.json?.stop_reason === "tool_use",
    `stop_reason=${messages.json?.stop_reason}`);

  const messagesStream = await anthropic({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: "What is the weather in Seoul? Use the tool." }],
    tools: ANTHROPIC_TOOLS,
    stream: true,
  });
  check("...and streams as a tool_use block with its input deltas",
    /"type"s*:s*"tool_use"/.test(messagesStream.body)
      && /input_json_delta/.test(messagesStream.body),
    messagesStream.body.slice(0, 500));
  check("...with no error event in the Claude-dialect stream",
    !/"type"s*:s*"error"/.test(messagesStream.body) && !/claude_cli_error/.test(messagesStream.body),
    messagesStream.body.slice(0, 500));
} catch (e) {
  check("harness completed", false, e.message);
} finally {
  if (server) server.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

const pass = results.filter((r) => r.ok).length;
if (pass !== results.length) console.log(`\n--- server log tail ---\n${log.slice(-3000)}`);
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
