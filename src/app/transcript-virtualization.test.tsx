import { describe, expect, it } from "vitest";
import {
  groupTranscriptItems,
  isNearTranscriptBottom,
  transcriptBlockIndexForItem,
} from "../transcript-utils";
import {
  transcriptAnchorScrollTop,
  transcriptRestoreSettled,
  transcriptViewportAnchor,
  type TranscriptAnchorRow,
} from "./transcript";
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

  it("treats a bottom-anchored scroll as following while rows are still mounting", () => {
    // The failure this encodes, measured on a ~1000-block session: scrolling back to the
    // bottom lands 577px short, because rows above are unmounted and the scroll height is
    // still an estimate. The scroll handler ran with a 48px threshold, decided the view
    // was not near the bottom, and cleared the follow flag -- which then made the
    // correction loop exit on its own guard. The view stayed 577px short with a blank
    // band under the newest message, and the 최신 내용으로 button never went away.
    //
    // A virtualized transcript needs a threshold wider than the estimation error, and one
    // viewport of slack is the natural bound: further than that and the user really has
    // scrolled away.
    const clientHeight = 617;
    const scrollHeight = 146_000;
    const landedShortBy = 577;
    const scrollTop = scrollHeight - clientHeight - landedShortBy;

    expect(isNearTranscriptBottom(scrollHeight, scrollTop, clientHeight)).toBe(
      false,
    );
    expect(
      isNearTranscriptBottom(scrollHeight, scrollTop, clientHeight, clientHeight),
    ).toBe(true);

    // Genuinely scrolled away stays away, so the button still appears when it should.
    expect(
      isNearTranscriptBottom(
        scrollHeight,
        scrollHeight / 2,
        clientHeight,
        clientHeight,
      ),
    ).toBe(false);
  });

  it("decides following from the scroll position, not from a mounted final block", () => {
    // The bug: following was force-enabled whenever the last block was mounted, on the
    // theory that it only mounts once the view is at the end. It does not. Measured on a
    // real session, overscan kept that block mounted up to 2000px -- 2.8 viewports --
    // above the bottom, so stopping anywhere in that band switched following back on and
    // the view was pulled to the bottom 120ms later. Scrolling up a little always snapped
    // back down.
    //
    // Only the scroll position decides. One viewport of slack absorbs the estimation error
    // from unmounted rows without swallowing a deliberate scroll away.
    const clientHeight = 720;
    const scrollHeight = 150_000;
    // Matches the threshold the transcript uses: a third of a viewport.
    const atDistance = (px: number) =>
      isNearTranscriptBottom(
        scrollHeight,
        scrollHeight - clientHeight - px,
        clientHeight,
        Math.round(clientHeight / 3),
      );

    // Inside the band where the final block is still mounted, the user is reading.
    expect(atDistance(1000)).toBe(false);
    expect(atDistance(2000)).toBe(false);

    // A deliberate nudge upward is left alone too, which a full-viewport threshold undid.
    expect(atDistance(400)).toBe(false);

    // Landing just short of the bottom is still following, which is what keeps a drag to
    // the end from stalling with a blank band under the newest message.
    expect(atDistance(200)).toBe(true);
    expect(atDistance(0)).toBe(true);
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

describe("holding the reading position across a width change", () => {
  // Opening or closing the detail panel changes the transcript's width, which re-wraps
  // every block: `measure()` discards each measured height and the rows are re-measured
  // one frame at a time, so the scroll position cannot be restored as a raw scrollTop.
  // These two helpers are the whole decision -- which row the viewport top sits on, and
  // the offset that puts it back -- and they work in layout pixels because the rect is
  // scaled by the window's zoom while scrollTop is not.
  const row = (
    key: string,
    top: number,
    height: number,
  ): TranscriptAnchorRow => ({ key, top, height });

  it("anchors on the row under the viewport top, not an overscan row above it", () => {
    // Overscan keeps a screenful of rows above the viewport mounted. Anchoring on the
    // first of those names a different place in the conversation -- the jump this fix is
    // about. The first row whose painted bottom passes the edge is the one being read.
    const rows = [
      row("block-a", -900, 400),
      row("block-b", -500, 620),
      row("block-c", 120, 300),
    ];
    expect(transcriptViewportAnchor(rows, 0)).toEqual({
      key: "block-b",
      offset: -500,
    });
  });

  it("keeps the anchored block and its offset when the rows above are re-measured", () => {
    const windowTop = 44;
    const anchor = transcriptViewportAnchor(
      [
        row("block-a", windowTop + 700, 300),
        row("block-b", windowTop + 1000, 500),
        row("block-c", windowTop + 1500, 260),
      ],
      1200,
    );
    // Partially clipped: the viewport top is 156px into the block, so its offset is
    // negative and has to survive as one.
    expect(anchor).toEqual({ key: "block-b", offset: -156 });

    // A taller block-a below.. above pushes everything down, which is exactly what a
    // re-measure does. The scroll position has to move (1200 -> 1320) so that the same
    // block stays at the same offset; keeping the raw scrollTop is what jumped the view.
    const movedStart = 1120;
    const restored = transcriptAnchorScrollTop(windowTop, movedStart, anchor!.offset);
    expect(restored).toBe(1320);
    expect(windowTop + movedStart - restored).toBe(anchor!.offset);
  });

  it("skips rows that end above the edge and reports the gap's next row", () => {
    const rows = [row("a", 0, 100), row("b", 118, 90)];
    // A row whose bottom is exactly at the edge is above it, not on it.
    expect(transcriptViewportAnchor(rows, 100)).toEqual({
      key: "b",
      offset: 18,
    });
    expect(transcriptViewportAnchor(rows, 0)).toEqual({ key: "a", offset: 0 });
    // Nothing mounted at the edge: there is no position to hold, so nothing is written.
    expect(transcriptViewportAnchor([row("a", 0, 100)], 140)).toBeNull();
  });

  it("keeps correcting while mounted rows are still on the size estimate", () => {
    // The failure this encodes, measured live in the panel smoke: the loop wrote the
    // bottom, the position matched it, and the total had held still -- so it stopped. The
    // next measurement pass grew the total by 953px, and the view was left 902px short of
    // the bottom with the 최신 내용으로 button back on screen. Landing on the target is not
    // the same statement as the reflow having finished.
    const frame = {
      landed: true,
      remaining: 0,
      measuring: false,
      unchangedGeometry: true,
    };
    expect(transcriptRestoreSettled(frame, true)).toBe(true);
    expect(transcriptRestoreSettled({ ...frame, measuring: true }, true)).toBe(false);
    // An anchor is no different: the rows above it are being re-measured, so its own
    // start is still about to move.
    expect(transcriptRestoreSettled({ ...frame, measuring: true }, false)).toBe(false);
  });

  it("requires the write to land and the geometry to hold still", () => {
    const settled = {
      landed: true,
      remaining: 0,
      measuring: false,
      unchangedGeometry: true,
    };
    // A clamped write is not a restored position.
    expect(transcriptRestoreSettled({ ...settled, landed: false }, true)).toBe(false);
    // Nor is one whose total or viewport height moved since the previous frame.
    expect(
      transcriptRestoreSettled({ ...settled, unchangedGeometry: false }, true),
    ).toBe(false);
    // Following is only done once the bottom is actually reached...
    expect(transcriptRestoreSettled({ ...settled, remaining: 902 }, true)).toBe(false);
    expect(transcriptRestoreSettled({ ...settled, remaining: 1 }, true)).toBe(true);
    // ...while an anchor only has to sit on its offset, however far off the bottom it is.
    expect(transcriptRestoreSettled({ ...settled, remaining: 109_274 }, false)).toBe(
      true,
    );
  });
});
