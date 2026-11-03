import { describe, it, expect } from "vitest";


const { groupApiKeysByCombo } = await import("@/shared/utils/usageGrouping");

const row = (keyName, combo, rawModel, requests) => ({ key: `${keyName}|${rawModel}|${combo}`, keyName, apiKeyMasked: "sk-1***a1", combo, rawModel, requests });

describe("API key usage: key → combo → model", () => {
  it("groups each key by the combo it called, with per-combo totals", () => {
    const groups = groupApiKeysByCombo([
      row("Coupang", "Mini", "gpt-6-luna", 5),
      row("Coupang", "Mini", "agnes-3.0-flash", 3),
      row("Coupang", null, "gpt-6-luna", 2),
      row("Other", "Image", "gpt-6-luna", 1),
    ]);
    expect(groups.map((g) => g.groupKey)).toEqual(["Coupang (sk-1***a1)", "Other (sk-1***a1)"]);
    const coupang = groups[0];
    expect(coupang.summary.requests).toBe(10);
    expect(coupang.subgroups.map((s) => [s.groupKey, s.summary.requests, s.items.length]))
      .toEqual([["Mini", 8, 2], ["No combo", 2, 1]]);
  });
});
