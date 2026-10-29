import {
  shouldFollowTranscript,
  TRANSCRIPT_BOTTOM_EPSILON_PX as BOTTOM_EPSILON_PX,
} from "../transcript-utils";

// How long a gesture keeps its say over the follow decision. Long enough to cover the
// smooth-scroll animation one notch triggers -- measured at ~157ms from the wheel event to
// the last scroll event -- so the position the gesture started from cannot cancel it.
export const GESTURE_WINDOW_MS = 400;

// How many frames in a row the position, the measured total, and the viewport height have
// to agree before a resize restoration is finished. Landing on the current bottom is not
// the same thing as measurement having stopped: after a width change rows are re-measured
// one frame at a time, and each pass moves the bottom again.
export const RESTORE_STABLE_FRAMES = 3;
// Bounded work. A restoration that cannot settle gives up instead of fighting the user.
export const RESTORE_MAX_FRAMES = 60;

// Bounded work for the hand-back to the newest content. Rows below the viewport are
// unmounted, so its bottom is an estimate that grows a frame at a time, and the composer
// giving up its typing height moves the viewport under the write.
export const LATEST_SETTLE_MAX_FRAMES = 60;

/** A mounted transcript row, in the unzoomed layout pixels the virtualizer positions it with. */
export interface TranscriptAnchorRow {
  /** Block key, as the virtualizer keys the row. */
  key: string;
  /** Row top edge, measured from the scroll container's content origin. */
  top: number;
  /** Painted row height at the current width. */
  height: number;
}

export interface TranscriptViewportAnchor {
  key: string;
  /** Distance from the viewport top to the row's top; negative when the row is clipped. */
  offset: number;
}

/**
 * The row the viewport top edge falls on: the first mounted row whose painted bottom
 * passes that edge, with its offset from the edge.
 *
 * The first *mounted* row is not the answer -- overscan keeps a screenful of rows above
 * the viewport mounted, and anchoring on one of those names a different place in the
 * conversation than the one being read.
 */
export function transcriptViewportAnchor(
  rows: TranscriptAnchorRow[],
  viewportTop: number,
): TranscriptViewportAnchor | null {
  for (const row of rows) {
    if (row.top + row.height <= viewportTop) continue;
    return { key: row.key, offset: row.top - viewportTop };
  }
  return null;
}

/**
 * Scroll offset that puts a row's top back at `offset` from the viewport top.
 *
 * Layout pixels throughout: offsetTop and offsetHeight are not scaled by the window's zoom
 * level while getBoundingClientRect is, and a zoom-scaled offset folded into scrollTop is
 * 10% wrong at the 110% this app is read at.
 */
export function transcriptAnchorScrollTop(
  windowTop: number,
  rowStart: number,
  offset: number,
): number {
  return windowTop + rowStart - offset;
}

/**
 * Whether a frame says the reading position has stopped moving.
 *
 * Landing on the target is not enough. After `measure()` the mounted rows are re-measured
 * one frame at a time, so a frame can look settled -- position on the bottom, anchor on its
 * offset -- and still be followed by the reflow that moves everything. Measured live, that
 * released the correction with the view 902px short of the bottom and the 최신 내용으로
 * button back on screen. A row still on its estimate, or geometry that moved since the
 * last frame, is the same statement: not finished yet.
 */
export function transcriptRestoreSettled(
  frame: {
    /** The write reached the wanted offset, rather than being clamped short of it. */
    landed: boolean;
    /** Distance from the viewport bottom to the content bottom, in layout pixels. */
    remaining: number;
    /** A mounted row is still carrying the size estimate instead of its measured height. */
    measuring: boolean;
    /** The total and the viewport height match the previous frame. */
    unchangedGeometry: boolean;
  },
  follow: boolean,
): boolean {
  if (!frame.landed || frame.measuring || !frame.unchangedGeometry) return false;
  return follow ? frame.remaining <= BOTTOM_EPSILON_PX : true;
}

/**
 * The width the reading column lays text out at, in the scroller's own pixels.
 *
 * The border box, not `clientWidth`: a scrollbar appearing or disappearing subtracts
 * itself from `clientWidth` without changing the space the transcript was given, and the
 * centered column is a percentage of exactly that space. Measured at a 900px window, the
 * transcript is 494px wide with a classic scrollbar and 494px with none -- `clientWidth`
 * reads 485 and 494 for those two states -- while the column it centers goes 451 -> 460,
 * so the old comparison saw a resize every time the scrollbar flickered and ran a full
 * anchored restoration while the user was typing.
 */
export function transcriptReadingWidth(scroller: HTMLElement): number {
  return scroller.offsetWidth;
}

/**
 * Whether a reading width that just came in starts a restoration, or is left to the
 * restoration already in flight.
 *
 * Three answers, and the middle one is what keeps a restore from restarting on every
 * keystroke:
 *
 *   - unchanged: a scrollbar, a composer that grew a line, or any other layout the
 *     reading width does not depend on. Nothing re-wraps, so nothing runs.
 *   - changed into a restoration already covering that width: it is converging on the
 *     position for this width already, and re-anchoring mid-flight is what made a
 *     restore run for as long as the user kept typing.
 *   - changed otherwise: a genuine re-wrap, so the position is restored at the new width.
 */
export function transcriptRestoreWidthDecision(
  readingWidth: number,
  lastWidth: number,
  coveredWidth: number,
): "unchanged" | "covered" | "restore" {
  if (readingWidth === lastWidth) return "unchanged";
  return readingWidth === coveredWidth ? "covered" : "restore";
}

/**
 * Whether a wheel or touch gesture takes the view off the newest content.
 *
 * Direction is input, not a hand-back. An upward gesture always takes the view; a downward
 * one takes it too unless the view is already at the newest content. The scroll position
 * cannot stand in for this: unmounted rows get a whole viewport of slack (see
 * `shouldFollowTranscript`), so a small scroll *toward* the newest content reads as "already
 * at the bottom", and treating that reading as arrived switched following back on -- which
 * then had the corrections carry the view the rest of the way, away from the text the user
 * was reading.
 */
export function transcriptGestureClaimsView(
  deltaY: number,
  remaining: number,
): boolean {
  return deltaY < 0 || remaining > BOTTOM_EPSILON_PX;
}

/**
 * The follow decision for one scroll reading, and the reading intent it leaves behind.
 *
 * The position alone cannot answer it: rows below the viewport are unmounted, so the scroll
 * height is an estimate and a drag to the end can land a few hundred pixels short of it.
 * That has to read as following, or the view stalls with a blank band under the newest
 * message. The intent is what keeps that slack from swallowing a deliberate move: while the
 * view is off the newest content, nothing short of arriving at it hands the view back.
 *
 * So the intent is a latch, cleared by the newest content being reached and by nothing else.
 * Scrolling back down a little is a position on the way there, not permission to follow
 * again; the direction of the gesture does not decide, and neither does the width of the
 * slack band. The one exception is the window: a gesture's opening scroll events report the
 * position it started from, so at the bottom they read as "arrived" before the gesture has
 * moved anything, and that would erase the gesture that took the view before it took it.
 * Once the window has ended, a landing inside the bottom epsilon is arrived.
 */
export function transcriptFollowDecision(frame: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  /** The view has been taken off the newest content and has not arrived back at it. */
  reading: boolean;
  /** How long ago the gesture that claimed the view happened. */
  gestureAgeMs: number;
}): { following: boolean; reading: boolean } {
  const remaining = frame.scrollHeight - frame.scrollTop - frame.clientHeight;
  const arrived =
    remaining <= BOTTOM_EPSILON_PX &&
    (!frame.reading || frame.gestureAgeMs >= GESTURE_WINDOW_MS);
  const reading = frame.reading && !arrived;
  return {
    reading,
    following:
      arrived ||
      shouldFollowTranscript(
        frame.scrollHeight,
        frame.scrollTop,
        frame.clientHeight,
        reading,
      ),
  };
}

/** Unzoomed offset of an element's top edge from the scroll container's content origin. */
export function layoutTopWithin(
  element: HTMLElement,
  container: HTMLElement,
): number | null {
  const box = container.getBoundingClientRect();
  const scale = container.offsetHeight > 0 ? box.height / container.offsetHeight : 1;
  if (!scale) return null;
  return (element.getBoundingClientRect().top - box.top) / scale + container.scrollTop;
}
