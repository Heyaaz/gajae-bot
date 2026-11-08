import { describe, expect, it } from "vitest";
import { questionSubmission, toolDecision } from "./gjc-input-validation.js";

describe("questionSubmission", () => {
  it.each([
    { kind: "value", value: "  exact option  " },
    { kind: "value", value: "first line\nsecond line\n" },
    { kind: "control", controlId: "navigation_forward" },
  ])("preserves request binding and exact CLI interaction values: %j", (answer) => {
    const submission = { selected: [], cli: { requestId: "request-1", answer } };
    expect(questionSubmission(submission)).toEqual(submission);
  });

  it.each([
    null, [], {}, { requestId: "", answer: { kind: "value", value: "A" } },
    { requestId: "request-1", answer: { kind: "value", value: "A", extra: true } },
    { requestId: "request-1", answer: { kind: "control", controlId: 1 } },
    { requestId: "request-1", answer: { kind: "value", value: "A".repeat(8_001) } },
    { requestId: "request-1", answer: { kind: "other", value: "A" } },
    { requestId: "request-1", answer: { kind: "value", value: "A" }, extra: true },
  ])("rejects malformed CLI answer %j at both public entry points", (cli) => {
    expect(() => questionSubmission({ selected: [], cli })).toThrow("CLI question");
  });

  it("rejects mixed workflow and CLI answers instead of silently discarding either", () => {
    const cli = { requestId: "request-1", answer: { kind: "value", value: "A" } };
    expect(() => questionSubmission({ selected: ["A"], cli })).toThrow();
    expect(() => questionSubmission({ selected: [], custom: "text", cli })).toThrow();
    expect(() => questionSubmission({ selected: [], clarify: "why?", cli })).toThrow();
  });
});

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

  it("keeps a command rule prefix in its normalized form", () => {
    expect(toolDecision({ optionId: "allow_once", rule: { prefix: "  git   status " } }))
      .toEqual({ optionId: "allow_once", rule: { prefix: "git status" } });
    expect(toolDecision({ optionId: "allow_once" })).not.toHaveProperty("rule");
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["chained", "git status && rm -rf x"],
    ["piped", "git log | sh"],
    ["substituted", "echo $(id)"],
    ["too long", "a".repeat(201)],
    ["not a string", 7],
  ])("refuses a %s rule prefix", (_name, prefix) => {
    expect(() => toolDecision({ optionId: "allow_once", rule: { prefix } })).toThrow("rule prefix");
  });

  it.each([null, "git status", 3, {}])("refuses a rule that is %j", (rule) => {
    expect(() => toolDecision({ optionId: "allow_once", rule })).toThrow("rule prefix");
  });
});
