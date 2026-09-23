import { describe, it, expect } from "vitest";
import {
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

describe("ignoredRequestFields", () => {
  it("names what is present and will not be acted on", () => {
    expect(ignoredRequestFields({ temperature: 0.2, max_tokens: 100, messages: [] }))
      .toEqual(["temperature", "max_tokens"]);
  });

  it("says nothing about fields that are absent or null", () => {
    expect(ignoredRequestFields({ messages: [], temperature: null })).toEqual([]);
    expect(ignoredRequestFields({})).toEqual([]);
  });

  it("counts a zero, which is a real setting and still ignored", () => {
    expect(ignoredRequestFields({ temperature: 0 })).toEqual(["temperature"]);
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
