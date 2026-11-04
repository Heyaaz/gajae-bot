import { describe, expect, it } from "vitest";
import { toolDecision } from "./gjc-input-validation.js";

describe("toolDecision", () => {
  it("keeps a rejection note and drops a blank one", () => {
    expect(toolDecision({ optionId: "reject_once", comment: "  Use ls instead " }))
      .toEqual({ optionId: "reject_once", comment: "Use ls instead" });
    expect(toolDecision({ optionId: "reject_once", comment: "   " })).toEqual({ optionId: "reject_once" });
  });

  it("refuses a note GJC would refuse", () => {
    expect(() => toolDecision({ optionId: "reject_once", comment: "x".repeat(4097) })).toThrow("comment");
    expect(() => toolDecision({ optionId: "reject_once", comment: 42 })).toThrow("comment");
  });
});
