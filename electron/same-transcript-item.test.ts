import { describe, expect, it, vi } from "vitest";
import { cloneTranscriptItem, sameTranscriptItem } from "./gjc-sdk-transcript.js";
import type { CliQuestionState, QuestionActivity, ToolActivity } from "../shared/agent-contract.js";

function tool(output: string): ToolActivity {
  return {
    id: "t1",
    kind: "tool",
    sessionId: "s1",
    name: "bash",
    description: "run",
    status: "completed",
    createdAt: "t",
    output,
  };
}

describe("sameTranscriptItem", () => {
  const question: QuestionActivity = {
    id: "cli-ask:q1", kind: "question", sessionId: "s1", question: "Choose", options: [{ label: "A" }],
    multi: true, status: "pending", createdAt: "t", answerable: true, tag: "pending", expectedSessionId: "s1",
    cli: { requestId: "request-1", interaction: "selector", selectedOptions: ["A"],
      controls: [{ id: "navigation_forward", label: "Done", enabled: true }],
      editor: { title: "Your answer", prefill: "A" },
    },
  };

  it.each<{ field: string; patch: Partial<CliQuestionState> }>([
    { field: "request identity", patch: { requestId: "request-2" } },
    { field: "interaction", patch: { interaction: "custom_editor" } },
    { field: "selection", patch: { selectedOptions: ["B"] } },
    { field: "control identity", patch: { controls: [{ id: "navigation_back", label: "Done", enabled: true }] } },
    { field: "control label", patch: { controls: [{ id: "navigation_forward", label: "Next", enabled: true }] } },
    { field: "control availability", patch: { controls: [{ id: "navigation_forward", label: "Done", enabled: false }] } },
    { field: "editor title", patch: { editor: { title: "Clarify", prefill: "A" } } },
    { field: "editor prefill", patch: { editor: { title: "Your answer", prefill: "B" } } },
    { field: "editor removal", patch: { editor: undefined } },
  ])("publishes a changed CLI question $field within the same logical card", ({ patch }) => {
    expect(sameTranscriptItem(question, { ...question, cli: { ...question.cli!, ...patch } })).toBe(false);
    expect(sameTranscriptItem(question, structuredClone(question))).toBe(true);
  });

  it("distinguishes an ordinary CLI question from a gate with otherwise identical fields", () => {
    expect(sameTranscriptItem(question, { ...question, cli: undefined })).toBe(false);
  });

  it("detaches mutable CLI state when returning a question snapshot", () => {
    const copy = cloneTranscriptItem(question) as QuestionActivity;
    copy.cli!.selectedOptions.push("B");
    copy.cli!.controls[0]!.enabled = false;
    copy.cli!.editor!.prefill = "changed";
    expect(question.cli!.selectedOptions).toEqual(["A"]);
    expect(question.cli!.controls[0]!.enabled).toBe(true);
    expect(question.cli!.editor!.prefill).toBe("A");
  });

  it("detects a same-length tool output change without serialising the row", () => {
    const left = tool(`${"a".repeat(64)}x`);
    const right = tool(`${"a".repeat(64)}y`);
    expect(left.output?.length).toBe(right.output?.length);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(sameTranscriptItem(left, right)).toBe(false);
      expect(sameTranscriptItem(left, { ...left })).toBe(true);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });
});
