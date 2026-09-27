import { describe, it, expect } from "vitest";
import {
  generationExtraBody,
  ignoredRequestFields,
  toolsAreWanted,
  unsupportedRequestFeature,
} from "open-sse/executors/claudeCliRequestSupport.js";

/**
 * The CLI is a coding agent, not the Messages API. Fields it has no equivalent
 * for used to be read off the body and dropped without a word, so a caller who
 * asked for JSON, or for a particular tool, got something else and no reason
 * why. A field that changes the shape of the promised answer is refused; one
 * that only tunes it is ignored and named.
 */

const TOOLS = [{ type: "function", function: { name: "f" } }];

describe("unsupportedRequestFeature", () => {
  it("passes an ordinary request", () => {
    expect(unsupportedRequestFeature({ messages: [] })).toBeNull();
    expect(unsupportedRequestFeature({ tools: TOOLS, tool_choice: "auto" })).toBeNull();
    expect(unsupportedRequestFeature({})).toBeNull();
  });

  it("refuses a forced tool, in either dialect", () => {
    // The model is asked, not instructed; there is no flag for forcing one.
    for (const tool_choice of [
      "required",
      "any",
      { type: "any" },
      { type: "tool", name: "f" },
      { type: "function", function: { name: "f" } },
    ]) {
      const refusal = unsupportedRequestFeature({ tools: TOOLS, tool_choice });
      expect(refusal?.code, JSON.stringify(tool_choice)).toBe("unsupported_tool_choice");
      expect(refusal.message).toMatch(/auto/);
    }
  });

  it("does not refuse a forced choice when there are no tools to force", () => {
    expect(unsupportedRequestFeature({ tool_choice: "required" })).toBeNull();
  });

  it("refuses a structured-output request rather than guessing at it", () => {
    expect(unsupportedRequestFeature({ response_format: { type: "json_schema" } })?.code)
      .toBe("unsupported_response_format");
    expect(unsupportedRequestFeature({ response_format: { type: "json_object" } })?.code)
      .toBe("unsupported_response_format");
    expect(unsupportedRequestFeature({ response_format: "json_object" })?.code)
      .toBe("unsupported_response_format");
    // A plain text format asks for nothing this cannot do.
    expect(unsupportedRequestFeature({ response_format: { type: "text" } })).toBeNull();
  });

  it("refuses more than one completion, which it answers once per request", () => {
    expect(unsupportedRequestFeature({ n: 2 })?.code).toBe("unsupported_n");
    expect(unsupportedRequestFeature({ n: 1 })).toBeNull();
  });
});

describe("generationExtraBody", () => {
  // Only stop sequences survive the trip. Measured on 2.1.280: a stop sequence
  // ended the answer where the caller asked, while temperature failed the
  // request outright ("may only be set to 1 when thinking is enabled") and a
  // max_tokens of 32 still produced 128 output tokens before the CLI reported
  // an error with no content.
  it("carries stop sequences, which the upstream request honours", () => {
    expect(generationExtraBody({ stop_sequences: ["END", "HALT"] }))
      .toEqual({ stop_sequences: ["END", "HALT"] });
  });

  it("takes a single stop string, which is how OpenAI sends one", () => {
    expect(generationExtraBody({ stop: "END" })).toEqual({ stop_sequences: ["END"] });
  });

  it("carries nothing else, because nothing else survives", () => {
    expect(generationExtraBody({ temperature: 0.2, top_p: 0.9, max_tokens: 100 })).toBeNull();
  });

  it("is nothing at all for a request that set none of them", () => {
    // No settings file is written then, so an ordinary request spawns exactly
    // what it always did.
    expect(generationExtraBody({ messages: [] })).toBeNull();
    expect(generationExtraBody({})).toBeNull();
  });

  it("drops empty entries rather than sending a stop sequence that matches nothing", () => {
    expect(generationExtraBody({ stop: ["", null, "OK"] })).toEqual({ stop_sequences: ["OK"] });
    expect(generationExtraBody({ stop: [""] })).toBeNull();
  });
});


describe("ignoredRequestFields", () => {
  it("names every field the CLI will not act on", () => {
    expect(ignoredRequestFields({ temperature: 0.2, seed: 7, messages: [] }))
      .toEqual(["temperature", "seed"]);
  });

  it("says nothing about a token ceiling, which is carried now", () => {
    // It used to be listed here, on a measurement that only covered
    // CLAUDE_CODE_EXTRA_BODY. CLAUDE_CODE_MAX_OUTPUT_TOKENS does bound the
    // answer — see outputTokenCeiling for what it honours and what it does not.
    expect(ignoredRequestFields({ max_tokens: 100, max_completion_tokens: 100 })).toEqual([]);
  });

  it("says nothing about stop sequences, which are carried", () => {
    expect(ignoredRequestFields({ stop: ["x"], stop_sequences: ["y"] })).toEqual([]);
  });

  it("says nothing about fields that are absent or null", () => {
    expect(ignoredRequestFields({ messages: [], seed: null })).toEqual([]);
    expect(ignoredRequestFields({})).toEqual([]);
  });
});

describe("toolsAreWanted", () => {
  it("honours tool_choice none by not advertising them at all", () => {
    expect(toolsAreWanted({ tool_choice: "none" })).toBe(false);
    expect(toolsAreWanted({ tool_choice: { type: "none" } })).toBe(false);
  });

  it("advertises them otherwise", () => {
    expect(toolsAreWanted({})).toBe(true);
    expect(toolsAreWanted({ tool_choice: "auto" })).toBe(true);
    expect(toolsAreWanted({ tool_choice: { type: "auto" } })).toBe(true);
  });
});
