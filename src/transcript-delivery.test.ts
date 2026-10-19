import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "./backend/types";
import { applyTranscriptPatch, transcriptDelivery } from "./transcript-utils";

const message = (id: string, content: string): TranscriptItem => ({
  id,
  kind: "message",
  sessionId: "s1",
  role: "assistant",
  content,
  createdAt: "t",
});

describe("transcriptDelivery", () => {
  it("sends the whole conversation on the first read and only the new row after", () => {
    const first = message("m1", "one");
    expect(transcriptDelivery(undefined, [first])).toEqual({
      kind: "full",
      items: [first],
    });
    const second = message("m2", "two");
    expect(transcriptDelivery([first], [first, second])).toEqual({
      kind: "patch",
      items: [second],
    });
  });

  it("sends a row whose text changed without changing length", () => {
    const before = message("m1", "abcd");
    const after = message("m1", "abce");
    expect(before.content.length).toBe(after.content.length);
    expect(transcriptDelivery([before], [after])).toEqual({
      kind: "patch",
      items: [after],
    });
  });

  it("sends the whole conversation when a row disappears", () => {
    const first = message("m1", "one");
    const second = message("m2", "two");
    expect(transcriptDelivery([first, second], [second])).toEqual({
      kind: "full",
      items: [second],
    });
  });
});

describe("applyTranscriptPatch", () => {
  it("keeps the rendered state when the patch is empty", () => {
    const current = { s1: [message("m1", "one")] };
    expect(applyTranscriptPatch(current, "s1", [])).toBe(current);
  });

  it("replaces only the changed row and appends a new one", () => {
    const first = message("m1", "one");
    const current = { s1: [first] };
    const edited = message("m1", "ONE");
    const added = message("m2", "two");
    const next = applyTranscriptPatch(current, "s1", [edited, added]);
    expect(next.s1).toEqual([edited, added]);
  });
});
