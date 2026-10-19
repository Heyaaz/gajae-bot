import { describe, expect, it, vi } from "vitest";
import { sameTranscriptItem } from "./gjc-sdk-transcript.js";
import type { ToolActivity } from "../shared/agent-contract.js";

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
