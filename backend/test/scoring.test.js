import { describe, expect, it } from "vitest";
import { calculateA11yScore } from "../src/scoring.js";

describe("A11yPilot weighted score", () => {
  it("scores only distinct tested passing and violating rules", () => {
    const result = calculateA11yScore({
      violations: [{ id: "image-alt", impact: "serious" }],
      passes: [{ id: "landmark-one-main" }, { id: "image-alt" }],
      incomplete: [{ id: "color-contrast" }],
      inapplicable: [{ id: "meta-viewport" }],
    });

    expect(result.score).toBe(20);
    expect(result.denominatorRules).toBe(2);
    expect(result.failedRuleCount).toBe(1);
    expect(result.incompleteRuleCount).toBe(1);
    expect(result.inapplicableRuleCount).toBe(1);
  });

  it("returns no score when every check is incomplete or inapplicable", () => {
    expect(calculateA11yScore({
      incomplete: [{ id: "color-contrast" }],
      inapplicable: [{ id: "meta-viewport" }],
    }).score).toBeNull();
  });

  it("does not score an incomplete rule as a confirmed pass", () => {
    const result = calculateA11yScore({
      passes: [{ id: "color-contrast" }, { id: "landmark-one-main" }],
      incomplete: [{ id: "color-contrast" }],
    });

    expect(result.score).toBe(100);
    expect(result.denominatorRules).toBe(1);
    expect(result.passedRuleCount).toBe(1);
    expect(result.incompleteRuleCount).toBe(1);
  });
});
