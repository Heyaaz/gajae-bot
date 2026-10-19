import { describe, expect, it } from "vitest";
import {
  appendProgressBlock,
  GAJAE_PROGRESS_ROW_HEIGHT,
  groupTranscriptItems,
  isNearTranscriptBottom,
  gajaeEmoticonFor,
  resolveTurnProgress,
  transcriptBlockIndexForItem,
  transcriptRowEstimate,
  type TurnActivityKind,
} from "../transcript-utils";
import {
  transcriptAnchorScrollTop,
  transcriptFollowDecision,
  transcriptGestureClaimsView,
  transcriptRestoreSettled,
  transcriptRestoreWidthDecision,
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

describe("restoring only when the reading width really changed", () => {
  // The report: typing in the composer made the blocks shake. Typing grows the composer,
  // the composer takes its height from the transcript, and the transcript's scrollbar
  // flickers as the two heights cross -- and the restore was watching the column's
  // clientWidth, which a scrollbar changes by its own width. Measured at a 900px window:
  // the transcript is 494px wide with a classic scrollbar and 494px with none, while
  // clientWidth reads 485 and 494 and the centered column it feeds goes 451 -> 460. Every
  // flick started a full multi-frame anchored restoration, which is the shake.
  const SCROLLBAR_PX = 9;
  const WINDOW_READING_WIDTH = 494;
  const COLUMN_PX = WINDOW_READING_WIDTH - 48;

  it("ignores the width a scrollbar subtracts from the column", () => {
    // clientWidth twice, for the two scrollbar states, against a reading width that has
    // not moved.
    expect(COLUMN_PX + SCROLLBAR_PX).not.toBe(COLUMN_PX);

    expect(
      transcriptRestoreWidthDecision(WINDOW_READING_WIDTH, WINDOW_READING_WIDTH, 0),
    ).toBe("unchanged");
    // Even if a restoration is running for an unrelated width, a scrollbar flicker is
    // still not a reading width and does not touch it.
    expect(
      transcriptRestoreWidthDecision(WINDOW_READING_WIDTH, WINDOW_READING_WIDTH, 260),
    ).toBe("unchanged");
  });

  it("does not let a keystroke restart a restoration already in flight", () => {
    // The reading width moved once -- the inspector opened -- but the restoration is
    // already converging on that width. The observer fires again on the next frame, as it
    // does on every layout tick; re-anchoring the restore from there is what kept one
    // running for as long as the user kept typing.
    const opened = 286;
    expect(transcriptRestoreWidthDecision(opened, WINDOW_READING_WIDTH, opened)).toBe(
      "covered",
    );
    // A width the restoration is not handling is a new re-wrap and does start one.
    expect(transcriptRestoreWidthDecision(350, opened, opened)).toBe("restore");
  });

  it("starts a restoration when the space itself changes", () => {
    // Opening the inspector, resizing the window, or the shell settling at startup are the
    // real ones: text re-wraps, so the reading position has to be restored.
    const opened = 286;
    expect(transcriptRestoreWidthDecision(opened, WINDOW_READING_WIDTH, 0)).toBe(
      "restore",
    );
    expect(
      transcriptRestoreWidthDecision(WINDOW_READING_WIDTH, opened, opened),
    ).toBe("restore");
  });
});

describe("keeping a small downward scroll from jumping to the bottom", () => {
  // The report: a reader a little above the newest content scrolls down one notch and the
  // view jumps all the way to the bottom.
  //
  // Two rules meet at that position. The slack for unmounted rows is a whole viewport wide,
  // because a drag to the end can land hundreds of pixels short of an estimated total -- and
  // one wheel notch lands in that same band. What separates them is the reading intent, and
  // the intent used to be cleared by any downward delta: the notch moved the view down a
  // little, read as "still near the bottom", switched following back on, and the deferred
  // bottom correction (80ms of chase, 120ms of settle timer) carried it the rest of the way.
  //
  // So the intent is a latch now. A gesture takes it; the newest content being reached, the
  // 최신 내용으로 button, and a session switch are the only things that give it back.
  const VIEWPORT_PX = 760;
  const CONTENT_PX = 40_000;
  /** A scroll reading `remaining` px above the content bottom, with the intent as given. */
  const reading = (
    remaining: number,
    readingIntent: boolean,
    gestureAgeMs = 0,
  ) => ({
    scrollHeight: CONTENT_PX,
    scrollTop: CONTENT_PX - VIEWPORT_PX - remaining,
    clientHeight: VIEWPORT_PX,
    reading: readingIntent,
    gestureAgeMs,
  });
  const NEAR_BOTTOM_PX = 300; // Inside the viewport-wide slack, well outside the bottom.

  it("keeps the reading position after a small downward scroll near the bottom", () => {
    // The gesture: one notch toward the newest content, ~109px of it. It claims the view
    // because the view has not arrived at the newest content -- the distance is the slack's
    // business, not the gesture's.
    expect(transcriptGestureClaimsView(109, NEAR_BOTTOM_PX)).toBe(true);

    const held = transcriptFollowDecision(reading(NEAR_BOTTOM_PX - 109, true));
    expect(held.following).toBe(false);
    expect(held.reading).toBe(true);

    // The same position with the latch dropped is "near the bottom" and follows -- which is
    // the jump, and is exactly what a downward delta used to do to the intent.
    expect(
      transcriptFollowDecision(reading(NEAR_BOTTOM_PX - 109, false)).following,
    ).toBe(true);
  });

  it("holds the position while incoming chunks grow the content below it", () => {
    // A reply keeps arriving under the reader: every chunk adds height below the viewport
    // while the position does not move, so the gap to the bottom grows rather than closes.
    // Both deferred corrections are gated on this flag, so it may not flip to following at
    // any point in the arrival -- and the latch has to survive it.
    let readingIntent = true;
    let scrollHeight = CONTENT_PX;
    const scrollTop = CONTENT_PX - VIEWPORT_PX - NEAR_BOTTOM_PX;
    for (const [index, chunk] of [180, 240, 90, 420, 160].entries()) {
      scrollHeight += chunk;
      const decision = transcriptFollowDecision({
        scrollHeight,
        scrollTop,
        clientHeight: VIEWPORT_PX,
        reading: readingIntent,
        gestureAgeMs: 500 + index * 250,
      });
      readingIntent = decision.reading;
      expect(decision.following).toBe(false);
      expect(decision.reading).toBe(true);
      // The reader's own gap is untouched by the chunks landing under it.
      expect(scrollHeight - scrollTop - VIEWPORT_PX).toBeGreaterThan(
        NEAR_BOTTOM_PX,
      );
    }
  });

  it("arms no deferred correction while the view is away from the bottom", () => {
    // Every timer the component runs is gated on the follow decision: the 80ms chase and the
    // 120ms settle timer are only started when it is true, and the 400ms gesture window only
    // decides when a latch may be released. Away from the bottom the answer is false across
    // all of them.
    for (const age of [0, 80, 120, 121, 399, 401, 5_000]) {
      const decision = transcriptFollowDecision(
        reading(NEAR_BOTTOM_PX, true, age),
      );
      expect(decision.following).toBe(false);
      expect(decision.reading).toBe(true);
    }
  });

  it("hands the view back on reaching the newest content, and only then", () => {
    // The reader scrolls the rest of the way down. Short of the bottom is still a position
    // in the slack band, and it is still theirs.
    expect(transcriptFollowDecision(reading(109, true, 900)).following).toBe(
      false,
    );

    const arrived = transcriptFollowDecision(reading(0, true, 900));
    expect(arrived.following).toBe(true);
    expect(arrived.reading).toBe(false);

    // Except inside the gesture window. Its opening scroll events report the position the
    // gesture started from, so a wheel notch that begins at the bottom reads as arrived
    // before it has moved anything -- and releasing the latch there would erase the gesture
    // that just took the view.
    const openingEvent = transcriptFollowDecision(reading(0, true, 150));
    expect(openingEvent.reading).toBe(true);

    // The 최신 내용으로 button is the other hand-back: it clears the latch outright, so the
    // position it scrolls to is following from its first frame.
    const asked = transcriptFollowDecision(reading(0, false));
    expect(asked.following).toBe(true);
    expect(asked.reading).toBe(false);
  });

  it("keeps the slack a scrollbar drag to the end needs", () => {
    // A drag on the scrollbar is not a wheel or touch gesture, so nothing claims the view
    // and the slack has to stay live: the drag lands 577px short of an estimated total on a
    // real session, and without the band that position reads as "reading" and the view
    // stalls with a blank band under the newest message.
    expect(transcriptFollowDecision(reading(577, false)).following).toBe(true);
    // Further than a viewport away is a position, not a measurement error.
    expect(transcriptFollowDecision(reading(2_000, false)).following).toBe(false);

    // A downward gesture at the newest content claims nothing: there is no position to
    // hold, and the estimate still needs its slack.
    expect(transcriptGestureClaimsView(109, 0)).toBe(false);
    // An upward one claims it even from the bottom, which is where reading older content
    // starts, and the gesture window above is what keeps its opening event from releasing
    // the latch before it has moved anything.
    expect(transcriptGestureClaimsView(-109, 0)).toBe(true);
  });
});

describe("gajae progress row height", () => {
  const user = {
    id: "user-1",
    sessionId: "session-1",
    kind: "message" as const,
    role: "user" as const,
    content: "고쳐 줘",
    createdAt: "now",
  };

  it("keeps a fixed estimate when the progress row changes kind", () => {
    // The row is the last virtual block, and it appears, hides while the answer
    // streams, then comes back as a summary. A kind change that also changed
    // the estimate would move every offset below it — there is nothing below
    // it, but the total the follow loop chases would still jump. Every kind
    // therefore reserves the same height the row actually paints.
    const kinds: TurnActivityKind[] = [
      "thinking",
      "tool",
      "waiting",
      "approval",
      "done",
      "error",
    ];
    for (const kind of kinds) {
      expect(transcriptRowEstimate("progress")).toBe(GAJAE_PROGRESS_ROW_HEIGHT);
      expect(gajaeEmoticonFor(kind)).toBeTruthy();
    }

    const items = [user];
    const grouped = groupTranscriptItems(items);
    const running = resolveTurnProgress(
      items,
      { status: "running" },
      "session-1",
      undefined,
      1_000,
    );
    const withProgress = appendProgressBlock(grouped, running.progress);
    const height = (blocks: readonly { kind: string }[]) =>
      blocks.reduce(
        (sum, block) =>
          sum +
          transcriptRowEstimate(block.kind === "progress" ? "progress" : "item"),
        0,
      );
    expect(height(withProgress) - height(grouped)).toBe(GAJAE_PROGRESS_ROW_HEIGHT);

    const done = resolveTurnProgress(
      items,
      { status: "idle" },
      "session-1",
      running.stored,
      4_000,
    );
    expect(done.progress?.work.kind).toBe("done");
    expect(height(appendProgressBlock(grouped, done.progress))).toBe(
      height(withProgress),
    );
    // Earlier rows keep their ids, so the virtualizer does not remount them
    // when the progress row is added or its kind changes.
    expect(withProgress.slice(0, grouped.length).map((block) => block.id)).toEqual(
      grouped.map((block) => block.id),
    );
    expect(appendProgressBlock(grouped, done.progress).at(-1)?.id).toBe(
      withProgress.at(-1)?.id,
    );
  });
});
