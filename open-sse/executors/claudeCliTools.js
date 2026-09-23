/**
 * Showing a caller's tools to Claude Code, and getting the calls back out.
 *
 * Claude Code only proposes a tool it can see, and the CLI has no flag for
 * "here are some tool schemas" — `--tools` selects from its own built-in set.
 * The one surface that takes arbitrary tools is MCP, so the caller's tools are
 * advertised by an MCP server that implements the inventory and refuses to run
 * anything. Execution belongs to the client that asked: 9Router is a gateway,
 * and a proposed call goes back over the wire as `tool_calls` exactly as it
 * would from any other provider.
 *
 * The cost of using MCP is a namespace: the CLI renames every MCP tool to
 * `mcp__<server>__<tool>`, so the prefix has to come back off before the call
 * reaches the client, which knows only the name it sent.
 */
import { CLAUDE_CLI_MCP_SERVER, CLAUDE_CLI_MCP_TOOL_PREFIX } from "../config/claudeCli.js";

// MCP tool names travel through the CLI's own namespacing and back; keep them
// to the characters that survive that round trip unchanged.
const MCP_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** The schema an MCP server must advertise, from either request dialect. */
function toolDescriptor(tool) {
  if (!tool || typeof tool !== "object") return null;

  // OpenAI: { type: "function", function: { name, description, parameters } }
  // Claude/bare: { name, description, input_schema }
  const fn = tool.function && typeof tool.function === "object" ? tool.function : tool;
  const name = typeof fn.name === "string" ? fn.name.trim() : "";
  if (!MCP_NAME_PATTERN.test(name)) return null;

  const schema = fn.parameters ?? fn.input_schema ?? tool.input_schema;
  return {
    name,
    description: typeof fn.description === "string" ? fn.description : "",
    // An absent schema still has to be an object schema, or the CLI rejects the
    // server's inventory and the whole request dies with it.
    inputSchema: schema && typeof schema === "object" && !Array.isArray(schema)
      ? schema
      : { type: "object", properties: {} },
  };
}

/**
 * @param {Array<object>} tools request tools, in either dialect
 * @returns {Array<object>} MCP descriptors; empty when there is nothing usable
 */
export function toMcpManifest(tools) {
  if (!Array.isArray(tools)) return [];
  const seen = new Set();
  const manifest = [];
  for (const tool of tools) {
    const descriptor = toolDescriptor(tool);
    // A duplicate name would make the call ambiguous on the way back.
    if (!descriptor || seen.has(descriptor.name)) continue;
    seen.add(descriptor.name);
    manifest.push(descriptor);
  }
  return manifest;
}

/**
 * The name the caller used, recovered from the CLI's namespaced form.
 * Anything without the prefix is passed through untouched — a built-in tool
 * would arrive that way, and renaming it would be a lie.
 */
export function callerToolName(name) {
  const text = String(name || "");
  return text.startsWith(CLAUDE_CLI_MCP_TOOL_PREFIX)
    ? text.slice(CLAUDE_CLI_MCP_TOOL_PREFIX.length)
    : text;
}

/**
 * A JSON value as a JavaScript source literal.
 *
 * JSON is a subset of JavaScript expression syntax on every runtime this can
 * reach — the generated program runs on the server's own Node, not a browser —
 * so stringify is the whole conversion.
 */
function jsLiteral(value) {
  return JSON.stringify(value);
}

/**
 * The inert MCP server, as a complete program with its inventory baked in.
 *
 * Generated rather than shipped as a file on purpose. The CLI spawns it by
 * path, and a path to a file sitting next to this module cannot be computed
 * reliably: `import.meta.url` is rewritten by the bundler that builds the
 * dashboard, and Next's standalone output traces imports, not siblings. A
 * program written into the request's own temp directory has no such path to
 * resolve, and carries its manifest with it instead of reading a second file.
 *
 * It answers three methods and nothing else: `initialize`, `tools/list`, and
 * `tools/call` — the last with a refusal, so a model that tries to invoke a
 * tool gets a definite answer instead of a silent hang. In practice it never
 * gets that far: the turn ends on the proposal.
 */
export function inertMcpServerSource(manifest) {
  return `// Generated per request by open-sse/executors/claudeCliTools.js.
// Inventory only: this server advertises the caller's tools and runs none of
// them. 9Router hands every proposed call back to the client that asked.
const MANIFEST = ${jsLiteral(manifest)};

function resultFor(method) {
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: ${jsLiteral(CLAUDE_CLI_MCP_SERVER)}, version: "1" },
    };
  }
  if (method === "tools/list") return { tools: MANIFEST };
  if (method === "tools/call") {
    return {
      isError: true,
      content: [{
        type: "text",
        text: "Denied: these tools are inert here. 9Router returns the call to "
          + "the client that requested it, and only that client executes it.",
      }],
    };
  }
  return {};
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    // A notification carries no id and expects no reply.
    if (row.id === undefined || row.id === null) continue;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: row.id,
      result: resultFor(row.method),
    }) + "\\n");
  }
});
`;
}

/** The `--mcp-config` document that points the CLI at the generated server. */
export function mcpConfigDocument(nodeBin, serverPath) {
  return {
    mcpServers: {
      [CLAUDE_CLI_MCP_SERVER]: {
        command: nodeBin,
        args: [serverPath],
      },
    },
  };
}
