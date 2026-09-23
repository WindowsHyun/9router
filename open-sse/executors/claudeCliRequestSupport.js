/**
 * What a request can ask of the Claude Code CLI, and what it cannot.
 *
 * The CLI is a coding agent, not the Messages API: it has no flag for
 * temperature, for a token ceiling, for stop sequences, or for forcing a
 * particular tool. Those fields used to be read off the body and dropped
 * without a word, so a caller that asked for JSON, or for a specific tool, or
 * for one short answer, got something else and no indication why.
 *
 * Two kinds of gap, treated differently:
 *
 *   - A field whose absence changes the shape of the answer the caller
 *     promised their own user — a forced tool, a JSON schema, several
 *     completions — is refused. Answering anyway would be answering a
 *     different question.
 *   - A field that only tunes an answer we can still give — temperature, a
 *     token ceiling — is ignored, and named in the log so the difference is
 *     visible when the output is not what someone expected.
 *
 * `tool_choice: "none"` is neither: it is honoured, by not advertising the
 * tools at all.
 */

/** Fields the CLI has no equivalent for, which are dropped rather than refused. */
const IGNORED_FIELDS = [
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "stop_sequences",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "logit_bias",
];

function toolChoiceKind(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) return "auto";
  if (typeof toolChoice === "string") {
    if (toolChoice === "none") return "none";
    if (toolChoice === "auto") return "auto";
    // OpenAI "required", Claude "any": the model must call something.
    return "forced";
  }
  if (typeof toolChoice === "object") {
    const type = String(toolChoice.type || "");
    if (type === "none") return "none";
    if (type === "auto") return "auto";
    // { type: "tool", name } / { type: "function", function: { name } } / "any"
    return "forced";
  }
  return "auto";
}

/**
 * The reason this request cannot be served, or null.
 * @returns {{ message: string, code: string } | null}
 */
export function unsupportedRequestFeature(body = {}) {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  if (hasTools && toolChoiceKind(body.tool_choice) === "forced") {
    return {
      code: "unsupported_tool_choice",
      message: "Claude Code CLI cannot be made to call a particular tool: it is asked, "
        + "not instructed, and there is no flag for forcing one. Send tool_choice "
        + "\"auto\" (or omit it) and let the model decide, or use a provider backed by "
        + "the API for this request.",
    };
  }

  const format = body.response_format;
  const formatType = typeof format === "string" ? format : format?.type;
  if (formatType === "json_object" || formatType === "json_schema") {
    return {
      code: "unsupported_response_format",
      message: "Claude Code CLI cannot guarantee a JSON response: it has no structured "
        + "output mode, so a schema would be a request the model may simply not follow. "
        + "Ask for JSON in the prompt if best effort is enough, or use a provider backed "
        + "by the API.",
    };
  }

  if (Number(body.n) > 1) {
    return {
      code: "unsupported_n",
      message: "Claude Code CLI answers once per request; n > 1 has no equivalent. "
        + "Send the request as many times as you need completions.",
    };
  }

  return null;
}

/** Fields present on this request that the CLI will not act on. */
export function ignoredRequestFields(body = {}) {
  return IGNORED_FIELDS.filter((field) => body[field] !== undefined && body[field] !== null);
}

/** Whether the caller's tools should be advertised at all. */
export function toolsAreWanted(body = {}) {
  return toolChoiceKind(body.tool_choice) !== "none";
}
