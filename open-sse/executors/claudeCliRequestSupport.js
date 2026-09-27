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

/**
 * Fields the CLI will not act on, each for a measured reason (2.1.280):
 *
 *   temperature/top_p/top_k  the request fails outright — "temperature may only
 *                            be set to 1 when thinking is enabled", and Claude
 *                            Code runs with thinking on.
 *   seed/penalties/logprobs  no equivalent in Anthropic's API at all.
 *
 * They are named in the log rather than refused, because none of them changes
 * what the answer *is* — only how it would have been shaped.
 */
const IGNORED_FIELDS = [
  // One turn per request, as the Hermes plugin does and as this endpoint's
  // semantics require: an agent loop belongs to the client. It is also what
  // lets the cache relay admit exactly one model call.
  "max_turns",
  "temperature",
  "top_p",
  "top_k",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "logit_bias",
];

/**
 * A ceiling on the answer, in the one form the CLI accepts.
 *
 * Not through CLAUDE_CODE_EXTRA_BODY — measured there with a limit of 32, the
 * model produced 128 output tokens and the CLI then reported an error with no
 * content at all. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is a different channel and it
 * does bound the answer. Measured on 2.1.281, same prompt:
 *
 *   unset  476 output tokens, end_turn,      691 chars
 *   1024   882 output tokens, end_turn,     1547 chars
 *   128    512 output tokens, stop_sequence, 155 chars, is_error
 *   64     256 output tokens, stop_sequence, 154 chars, is_error
 *
 * So it is a ceiling the CLI applies loosely rather than the exact number, and
 * when it binds the turn is flagged as an error even though the content is
 * there. Both are handled: the value is passed, and a bound turn is delivered
 * as a completion that stopped early rather than as a failure. Approximate
 * beats ignored — a caller that asked for a short answer was getting whatever
 * the model felt like writing, and paying for it.
 *
 * @returns {string} the value for the child env, or "" when none was asked for
 */
export function outputTokenCeiling(body = {}) {
  const asked = body.max_tokens ?? body.max_completion_tokens;
  const limit = Number(asked);
  if (!Number.isInteger(limit) || limit < 1) return "";
  return String(limit);
}

/**
 * Generation fields the CLI does carry, in the shape the upstream body takes.
 *
 * Only stop sequences survive the trip. The CLI has no flag for them, but it
 * applies CLAUDE_CODE_EXTRA_BODY to the request it sends — verified on 2.1.280,
 * where a stop sequence ended the answer where the caller asked. Everything
 * else that could go here either fails the request or is not honoured; see
 * IGNORED_FIELDS.
 */
export function generationExtraBody(body = {}) {
  // OpenAI sends a string or a list; Claude takes a list either way.
  const stop = body.stop_sequences ?? body.stop;
  const stopList = typeof stop === "string" ? [stop] : Array.isArray(stop) ? stop : [];
  const stops = stopList.filter((entry) => typeof entry === "string" && entry.length > 0);
  return stops.length ? { stop_sequences: stops } : null;
}

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
