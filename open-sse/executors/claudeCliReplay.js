/**
 * Replaying a conversation into Claude Code as a conversation.
 *
 * `claude -p` takes one prompt on stdin, so history used to be flattened into a
 * single block of text with `[User]` / `[Assistant]` / `[Tool result]` markers.
 * The model then reads a transcript *about* a conversation instead of having
 * had one: tool results are prose rather than results linked to the call that
 * produced them, and every request is a fresh giant prompt with nothing to
 * cache.
 *
 * `--input-format stream-json` takes the real thing — one JSON frame per turn,
 * with the same content blocks the API uses. Historical frames carry
 * `shouldQuery: false`, which the CLI acknowledges without calling the model
 * (measured: `num_turns: 0`, zero input tokens); only the last frame queries.
 *
 * That last frame has to be a user or tool turn — there is nothing to query
 * otherwise — so a conversation ending on an assistant message (a prefill) has
 * no replay and keeps the flattened prompt, rather than having a continuation
 * invented for it.
 */

/**
 * An attachment in the shape the CLI reads, or null.
 *
 * Two dialects arrive here. Claude's own blocks pass straight through. OpenAI's
 * `image_url` carries either a data: URL, which is the same base64 the CLI
 * wants once it is taken apart, or a remote one, which is handed over as a url
 * source — if the CLI cannot fetch it the caller gets an error, which beats an
 * image that silently was not there.
 */
function attachmentBlock(part) {
  if (!part || typeof part !== "object") return null;

  if ((part.type === "image" || part.type === "document") && part.source) return part;

  const url = part.type === "image_url"
    ? (typeof part.image_url === "string" ? part.image_url : part.image_url?.url)
    : (part.type === "input_image" ? part.image_url || part.url : null);
  if (typeof url !== "string" || !url) return null;

  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data) {
    return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  }
  return { type: "image", source: { type: "url", url } };
}

/** Text of one content part, for the parts that carry any. */
function partText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.input_text === "string") return part.input_text;
  return "";
}

function messageBlocks(message) {
  if (typeof message?.content === "string") {
    return message.content ? [{ type: "text", text: message.content }] : [];
  }
  if (!Array.isArray(message?.content)) return [];

  const blocks = [];
  for (const part of message.content) {
    // Tool blocks already in Claude shape pass straight through; a client that
    // speaks that dialect has given us exactly what the CLI wants.
    if (part?.type === "tool_use" || part?.type === "tool_result") {
      blocks.push(part);
      continue;
    }
    // In the order the caller sent them: an image referred to as "the first
    // one" has to still be the first one.
    const attachment = attachmentBlock(part);
    if (attachment) {
      blocks.push(attachment);
      continue;
    }

    const text = partText(part);
    if (text) blocks.push({ type: "text", text });
  }
  return blocks;
}

/** An assistant's proposed calls, in the names the CLI knows them by. */
function toolUseBlocks(message, toolPrefix) {
  if (!Array.isArray(message?.tool_calls)) return [];
  return message.tool_calls.map((call, index) => {
    const name = call.function?.name || call.name || "tool";
    const rawArguments = call.function?.arguments ?? call.arguments ?? {};
    let input = {};
    if (typeof rawArguments === "string") {
      try { input = JSON.parse(rawArguments); } catch { input = {}; }
    } else if (rawArguments && typeof rawArguments === "object") {
      input = rawArguments;
    }
    return {
      type: "tool_use",
      id: call.id || `call_${index}`,
      // Namespaced again on the way back in: the model proposed the call under
      // the CLI's own MCP name, and replaying it under the caller's name would
      // be a call to a tool that never existed in this conversation.
      name: name.startsWith(toolPrefix) ? name : `${toolPrefix}${name}`,
      input,
    };
  });
}

function toolResultBlock(message) {
  const content = typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content ?? "");
  return {
    type: "tool_result",
    tool_use_id: message.tool_call_id || message.tool_use_id || "",
    content,
  };
}

/**
 * @param {Array<object>} messages the request's messages, already OpenAI-shaped
 * @param {string} toolPrefix the CLI's MCP namespace for this server
 * @returns {{ system: string, frames: Array<object>|null }}
 *   `frames` is null when this conversation cannot be replayed and the caller
 *   should fall back to a flattened prompt.
 */
export function buildReplayFrames(messages, toolPrefix) {
  const systemParts = [];
  const turns = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    const role = String(message.role || "user");

    if (role === "system" || role === "developer") {
      const text = messageBlocks(message).map(partText).filter(Boolean).join("");
      if (text) systemParts.push(text);
      continue;
    }

    if (role === "tool") {
      // Consecutive results belong to one user turn: they answer the calls of a
      // single assistant message, and splitting them would claim turns that
      // never happened.
      const previous = turns[turns.length - 1];
      if (previous?.role === "user" && previous.isToolResult) {
        previous.blocks.push(toolResultBlock(message));
      } else {
        turns.push({ role: "user", isToolResult: true, blocks: [toolResultBlock(message)] });
      }
      continue;
    }

    if (role === "assistant") {
      const blocks = [...messageBlocks(message), ...toolUseBlocks(message, toolPrefix)];
      if (blocks.length) turns.push({ role: "assistant", blocks });
      continue;
    }

    const blocks = messageBlocks(message);
    if (blocks.length) turns.push({ role: "user", blocks });
  }

  const system = systemParts.join("\n\n");
  const last = turns[turns.length - 1];
  // Nothing to ask: no turns at all, or the conversation ends on the assistant.
  if (!last || last.role !== "user") return { system, frames: null };

  const frames = turns.map((turn, index) => {
    const frame = {
      type: turn.role,
      message: { role: turn.role, content: turn.blocks },
    };
    // Everything before the last user turn is history: acknowledged without a
    // model call, so replaying a long conversation costs one request, not one
    // per turn.
    if (index < turns.length - 1 && turn.role === "user") frame.shouldQuery = false;
    return frame;
  });

  return { system, frames };
}

/** The frames as the CLI reads them: one JSON document per line. */
export function framesToStdin(frames) {
  return `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`;
}

/**
 * Fold a system prompt too large for argv into the conversation itself.
 *
 * Windows caps a command line at 32,767 characters and a coding agent's system
 * prompt runs past it. `--system-prompt-file` is accepted by the binary but is
 * not equivalent — the same text delivered that way is not treated as
 * authoritative instruction — so the text goes into the first turn, marked, and
 * argv carries a stub telling the model to read it as its instructions.
 */
export function inlineSystemIntoFrames(frames, system) {
  if (!frames?.length || !system) return frames;
  const [first, ...rest] = frames;
  return [
    {
      ...first,
      message: {
        ...first.message,
        content: [{ type: "text", text: `[System]
${system}` }, ...first.message.content],
      },
    },
    ...rest,
  ];
}
