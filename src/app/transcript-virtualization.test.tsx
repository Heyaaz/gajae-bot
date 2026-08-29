import { describe, expect, it } from "vitest";
import {
  groupTranscriptItems,
  transcriptBlockIndexForItem,
} from "../transcript-utils";
import type { TranscriptItem } from "../backend/types";

const message = (id: string, content: string): TranscriptItem =>
  ({
    id,
    sessionId: "session-1",
    kind: "message",
    role: "assistant",
    content,
    createdAt: "now",
  }) as unknown as TranscriptItem;

const tool = (id: string): TranscriptItem =>
  ({
    id,
    sessionId: "session-1",
    kind: "tool",
    name: "bash",
    description: "bash",
    status: "completed",
    createdAt: "now",
  }) as unknown as TranscriptItem;

describe("locating a search hit that is not mounted", () => {
  // Virtualizing the transcript means a search hit is usually absent from the DOM, so
  // the old `getElementById` reveal found nothing and the view sat still. The
  // virtualizer needs the block's index to bring the row on screen first.
  it("finds the block index of an item rendered inside a collapsed tool run", () => {
    const items = [
      message("m1", "first"),
      tool("t1"),
      tool("t2"),
      tool("t3"),
      message("m2", "second"),
    ];
    const blocks = groupTranscriptItems(items);

    // Three consecutive tool calls collapse into one block, so indices are not item
    // positions: the run is block 1 and the trailing message is block 2.
    expect(blocks).toHaveLength(3);
    expect(transcriptBlockIndexForItem(blocks, "t3")).toBe(1);
    expect(transcriptBlockIndexForItem(blocks, "m2")).toBe(2);
    expect(transcriptBlockIndexForItem(blocks, "m1")).toBe(0);
  });

  it("reports a missing item instead of pointing at the first block", () => {
    // findIndex returns -1 for a miss; treating that as 0 would scroll to the top of
    // the session on every stale search hit.
    const blocks = groupTranscriptItems([message("m1", "first"), tool("t1")]);
    expect(transcriptBlockIndexForItem(blocks, "gone")).toBe(-1);
  });

  it("keeps block ids stable so the virtualizer does not remount rows", () => {
    // The virtualizer keys mounted rows by these ids. If a block's id changed as items
    // arrived, every row would remount on each transcript update and lose its measured
    // height, which is the cost virtualization exists to avoid.
    const first = groupTranscriptItems([message("m1", "a"), tool("t1")]);
    const second = groupTranscriptItems([
      message("m1", "a"),
      tool("t1"),
      tool("t2"),
    ]);
    expect(second[0].id).toBe(first[0].id);
    expect(second[1].id).toBe(first[1].id);
  });
});
