import ReactMarkdown from "react-markdown";
import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import remarkGfm from "remark-gfm";
import type {
  ArtifactContent,
  TodoSnapshotTask,
} from "../../shared/agent-contract";
import type { ToolActivity, TranscriptItem } from "../backend/types";
import { compactToolCommand, compactToolText } from "../composer-utils";
import {
  attachmentSummaryText,
  copyableMessageText,
  groupTranscriptItems,
  shouldFollowTranscript,
  recentUserRequests,
  transcriptScrollIntent,
  transcriptBlockIndexForItem,
} from "../transcript-utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Brain,
  Check,
  ChevronDown,
  Clock3,
  GitFork,
  ListChecks,
  Paperclip,
  ShieldCheck,
  Shrink,
  TerminalSquare,
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { httpUrls, humanRuntimeText, toolDisplayName, toolStatusLabel } from "./format";
import { DiffView, LinkPreviewCard, MessageCopyButton } from "./primitives";

// How long an upward gesture keeps its say over the follow decision. Long enough to
// cover the smooth-scroll animation one notch triggers -- measured at ~157ms from the
// wheel event to the last scroll event -- so the position the gesture started from
// cannot cancel it.
const GESTURE_WINDOW_MS = 400;

// How many frames in a row the position, the measured total, and the viewport height have
// to agree before a resize restoration is finished. Landing on the current bottom is not
// the same thing as measurement having stopped: after a width change rows are re-measured
// one frame at a time, and each pass moves the bottom again.
const RESTORE_STABLE_FRAMES = 3;
// Bounded work. A restoration that cannot settle gives up instead of fighting the user.
const RESTORE_MAX_FRAMES = 60;

// Constructing a DateTimeFormat costs more than formatting with one, and every todo
// snapshot carries the observation time it was read at. Same 24-hour shape the
// controller labels its own observations with, so the two read alike.
const TODO_CLOCK_LABEL = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

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
  return follow ? frame.remaining <= 1 : true;
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
function transcriptReadingWidth(scroller: HTMLElement): number {
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

/** Unzoomed offset of an element's top edge from the scroll container's content origin. */
function layoutTopWithin(
  element: HTMLElement,
  container: HTMLElement,
): number | null {
  const box = container.getBoundingClientRect();
  const scale = container.offsetHeight > 0 ? box.height / container.offsetHeight : 1;
  if (!scale) return null;
  return (element.getBoundingClientRect().top - box.top) / scale + container.scrollTop;
}

export interface TranscriptProps {
  sessionId: string;
  items: TranscriptItem[];
  compacting?: boolean;
  /** The persisted, window-wide reasoning-card preference. */
  thoughtsExpanded?: boolean;
  onToggleThoughtsExpanded?: () => void;
  revealItemId?: string;
  onRevealComplete?: (itemId: string) => void;
  onResolveTool: (toolId: string, optionId: string) => void;
  onReadArtifact?: (artifactId: string) => Promise<ArtifactContent>;
}

export function Transcript({
  sessionId,
  items,
  compacting = false,
  thoughtsExpanded = false,
  onToggleThoughtsExpanded,
  revealItemId,
  onRevealComplete,
  onResolveTool,
  onReadArtifact,
}: TranscriptProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  // Set while the code below is correcting the scroll position. Those writes fire the
  // scroll handler just like a user gesture, and mid-correction the view is legitimately
  // short of the bottom, so without this marker the handler concluded the user had
  // scrolled away and cleared the follow flag -- cancelling the very correction that was
  // running.
  const selfScrollingRef = useRef(false);
  // Pending bottom correction, so a burst of scroll events collapses into one.
  const settleTimerRef = useRef(0);
  // Set by a wheel or touch gesture, cleared once the view is back at the bottom. The
  // scroll position cannot carry this on its own: one notch is ~109px, which is inside
  // the slack that unmounted rows require, so a small scroll up read as "still at the
  // bottom" and was pulled straight back -- net movement 0px.
  const scrolledAwayRef = useRef(false);
  // When the last upward gesture happened. The first scroll event of a gesture still
  // reports the old position -- one notch fires it while scrollTop is unchanged and
  // remaining is 0 -- so clearing the intent on "at the bottom" erased the gesture
  // before it moved anything. A gesture stays in force until the scrolling it caused
  // has stopped.
  const gestureAtRef = useRef(0);
  const touchYRef = useRef<number | undefined>(undefined);
  const sessionRef = useRef(sessionId);
  // Frames of the in-flight resize restoration, so a gesture, a session switch, or the
  // next resize can take it over instead of a stale correction landing on top of it.
  const restoreFrameRef = useRef(0);
  // The reading width the in-flight restoration was started for. The observer compares
  // against it so a restoration already converging on a position is never restarted for a
  // width it is already handling -- which is what kept it running while the user typed.
  const restoreReadingWidthRef = useRef(0);
  const resizePreparedRef = useRef(false);
  const stableViewportRef = useRef<{
    width: number;
    follow: boolean;
    anchor: TranscriptViewportAnchor | null;
  } | null>(null);
  const [following, setFollowing] = useState(true);

  const blocks = useMemo(() => groupTranscriptItems(items), [items]);
  // The restoration runs across frames and has to name the anchored block, so it reads the
  // current blocks rather than the ones its effect closed over.
  const blocksRef = useRef(blocks);
  useLayoutEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);

  // Only the blocks near the viewport are mounted. A full session used to keep ~800
  // entries and 20,000 nodes live, which made every width change -- opening the detail
  // panel, resizing the window -- re-wrap and re-measure the whole document in one
  // frame. Estimates are refined by measuring each row as it mounts.
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => transcriptRef.current,
    estimateSize: () => 140,
    // offsetHeight, not getBoundingClientRect: the rect is scaled by the window's zoom
    // level while the offsets the virtualizer positions rows with are not. At 110% zoom
    // every row was recorded 10% too tall (941px measured as 1035px), so the reserved
    // space exceeded the content and left a ragged 11-104px gap between blocks.
    //
    // No margin arithmetic either: the slot owns the gap between blocks as padding, which
    // is already inside this box. Reading margins off the cards double counted the spacing
    // -- once in the measured height, again in layout -- for gaps of -154px to +81px.
    measureElement: (element) => (element as HTMLElement).offsetHeight,
    getItemKey: (index) => blocks[index]?.id ?? index,
    // Rows are only measured once mounted, and a row's real height runs from 61px to
    // 1415px against a single estimate. Too small an overscan and the rows arriving at the
    // bottom edge get positioned on the estimate before they are measured, so they
    // overlapped the row above by up to 445px. A screenful of slack ahead means they are
    // mounted and measured before they matter.
    overscan: 12,
  });

  const virtualItems = virtualizer.getVirtualItems();

  function rememberViewport(): void {
    const scroller = transcriptRef.current;
    const content = scroller?.querySelector<HTMLElement>(".transcript-window");
    if (!scroller || !content || restoreFrameRef.current || selfScrollingRef.current || resizePreparedRef.current) return;
    const saved = stableViewportRef.current;
    const width = transcriptReadingWidth(scroller);
    if (saved && saved.width !== width) return;
    const top = layoutTopWithin(content, scroller);
    if (top === null) return;
    stableViewportRef.current = {
      width,
      follow: followingRef.current,
      anchor: currentViewportAnchor(scroller, top),
    };
  }

  useLayoutEffect(() => {
    rememberViewport();
  });

  useEffect(() => {
    const prepare = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('button[title="세션 정보"], .inspector header button')) return;
      rememberViewport();
      resizePreparedRef.current = true;
      requestAnimationFrame(() => {
        if (restoreFrameRef.current === 0) resizePreparedRef.current = false;
      });
    };
    window.addEventListener("click", prepare, true);
    return () => window.removeEventListener("click", prepare, true);
  }, []);

  // A Transcript instance stays mounted while the user moves between sessions. The
  // old session's scroll offset, measured row heights, and "reading history" intent
  // are not valid in the new one. Reusing them is what opened a restored session 866px
  // above its newest message. Reset only when identity changes -- remounting the whole
  // virtualizer introduced an initial wide-layout measurement overlap.
  useLayoutEffect(() => {
    if (sessionRef.current === sessionId) return;
    // A pending restoration belongs to the session the user left.
    cancelResizeRestore();
    sessionRef.current = sessionId;
    stableViewportRef.current = null;
    followingRef.current = true;
    scrolledAwayRef.current = false;
    gestureAtRef.current = 0;
    touchYRef.current = undefined;
    selfScrollingRef.current = true;
    setFollowing(true);
    virtualizer.measure();
    if (blocks.length > 0)
      virtualizer.scrollToIndex(blocks.length - 1, { align: "end" });
    const frame = requestAnimationFrame(() => {
      const element = transcriptRef.current;
      if (element && followingRef.current)
        element.scrollTop = element.scrollHeight - element.clientHeight;
      selfScrollingRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [blocks.length, sessionId, virtualizer]);

  // Measure slots the first time they mount.
  //
  // The virtualizer observes each slot for resizes, and that works -- forcing a size change
  // on the first screen's rows snapped all 12 of them into place. The problem is that a row
  // mounts at its final size, so there is no resize to observe: rows keep the size
  // estimate while their real heights run past 1000px, and on first entry they overlapped
  // by up to 1097px with the text stacked on itself.
  //
  // Only slots whose recorded height is still the estimate. Re-measuring every mounted slot
  // on every render fought the virtualizer's own scroll compensation: scrolling up mounts
  // rows taller than the estimate, the content above grows, and it shifts scrollTop to hold
  // the view still. Redoing measurements underneath that cancelled it out, so 25 wheel
  // notches moved the view 10px -- scrolling up felt like being dragged back down.
  //
  // Comparing against the reserved height rather than tracking which keys were seen: a slot
  // can mount, be measured, unmount, and come back, and a seen-set would skip it the second
  // time and leave it on the estimate.
  //
  // useLayoutEffect so this lands before the browser paints the bad positions.
  useLayoutEffect(() => {
    const scroller = transcriptRef.current;
    if (!scroller) return;
    const reserved = new Map(virtualItems.map((row) => [row.index, row.size]));
    for (const slot of scroller.querySelectorAll<HTMLElement>(".transcript-slot")) {
      const index = Number(slot.dataset.index);
      const recorded = reserved.get(index);
      if (recorded === undefined) continue;
      // Within a pixel of the real height means the virtualizer already has it, and
      // re-reporting it is what interfered with scroll compensation.
      if (Math.abs(recorded - slot.offsetHeight) <= 1) continue;
      virtualizer.measureElement(slot);
    }
  }, [virtualItems, virtualizer]);

  const totalSize = virtualizer.getTotalSize();

  useEffect(() => {
    if (!followingRef.current || blocks.length === 0) return;
    if (!transcriptRef.current) return;
    // Keeping the newest message in view is the point of this pane, and virtualization
    // makes it a moving target: rows below are unmounted, so the scroll height is an
    // estimate that only firms up as they mount and get measured. One immediate scroll
    // lands short, so the correction is deferred until that measuring has happened.
    //
    // Keyed on the transcript's content, never on the measured total. Measurement changes
    // the total constantly while scrolling, and re-running then dragged the view back to
    // the bottom 80ms after every scroll up -- reading earlier messages was impossible.
    let frame = 0;
    let attempts = 0;
    // A scroll this correction did not perform means the user is scrolling. Comparing
    // positions cannot detect it: the correction chases a bottom that grows as rows are
    // measured, so its own writes move the position further than a wheel notch moves it
    // back. Measured with real wheel events, the loop wrote 168392 -> 168488 while the
    // user was scrolling up, pulling the view up to 96px past where they had stopped.
    let interrupted = false;
    const noteForeignScroll = (): void => {
      if (!selfScrollingRef.current) interrupted = true;
    };
    transcriptRef.current.addEventListener("scroll", noteForeignScroll, {
      passive: true,
    });
    const settle = (): void => {
      const element = transcriptRef.current;
      if (!element || !followingRef.current) {
        selfScrollingRef.current = false;
        return;
      }
      // Hand the view back the moment the user takes over. Suppressing the scroll handler
      // for the whole loop -- up to 30 frames -- also suppressed real input, so their
      // scroll was silently overwritten.
      if (interrupted) {
        selfScrollingRef.current = false;
        followingRef.current = false;
        setFollowing(false);
        return;
      }
      // Marked as our own scroll: mid-correction the position is legitimately short of the
      // bottom, and letting the scroll handler judge that would clear the follow flag and
      // cancel this.
      selfScrollingRef.current = true;
      element.scrollTop = element.scrollHeight - element.clientHeight;
      attempts += 1;
      const settled =
        element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
      if ((settled && attempts > 2) || attempts > 30) {
        selfScrollingRef.current = false;
        return;
      }
      frame = requestAnimationFrame(settle);
    };
    const timer = window.setTimeout(() => {
      frame = requestAnimationFrame(settle);
    }, 80);
    const scroller = transcriptRef.current;
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      scroller?.removeEventListener("scroll", noteForeignScroll);
      selfScrollingRef.current = false;
    };
  }, [blocks.length, items]);

  /**
   * Where the viewport top sits right now, read before `measure()` discards the row
   * heights. Only mounted rows can answer it, and only the one the viewport actually
   * reaches counts.
   *
   * The row tops come from the rendered transforms rather than the virtualizer's live
   * items: those can already carry the reflowed heights while the browser is still
   * painting the previous frame, and the anchor has to describe what the user is looking
   * at, not what React is about to draw.
   */
  function currentViewportAnchor(
    scroller: HTMLElement,
    _windowTop: number,
  ): TranscriptViewportAnchor | null {
    const rows: TranscriptAnchorRow[] = [];
    const box = scroller.getBoundingClientRect();
    const scale = box.height / scroller.offsetHeight || 1;
    for (const slot of scroller.querySelectorAll<HTMLElement>(
      ".transcript-slot",
    )) {
      const block = blocksRef.current[Number(slot.dataset.index)];
      const start = Number.parseFloat(
        slot.style.transform.match(/-?[\d.]+/u)?.[0] ?? "",
      );
      if (!block || !Number.isFinite(start)) continue;
      rows.push({
        key: block.id,
        top: scroller.scrollTop + (slot.getBoundingClientRect().top - box.top) / scale,
        height: slot.offsetHeight,
      });
    }
    return transcriptViewportAnchor(rows, scroller.scrollTop);
  }

  function releaseResizeRestore(): void {
    restoreFrameRef.current = 0;
    restoreReadingWidthRef.current = 0;
    selfScrollingRef.current = false;
    resizePreparedRef.current = false;
    stableViewportRef.current = null;
    rememberViewport();
  }

  // A pending restoration is dropped the moment the user takes over -- a wheel or touch
  // gesture, a search reveal, the latest-content button, a session switch, or the next
  // width change -- or its frames would write the old position on top of the new intent.
  function cancelResizeRestore(): void {
    if (restoreFrameRef.current === 0) return;
    cancelAnimationFrame(restoreFrameRef.current);
    releaseResizeRestore();
  }

  /**
   * Re-establish the reading position across a width change.
   *
   * A width change re-wraps every block, so `measure()` throws every measured height away
   * and rows are re-measured one frame at a time. Restoring a raw scrollTop does not
   * survive that: rows are repositioned from estimates, which moves the block the user was
   * reading and can even clamp the position. So the reading position is frozen first --
   * whether the view was following the bottom, and for older content the block the viewport
   * top sits on plus its offset -- and then the offset is corrected every frame until the
   * position, the total, and the viewport height hold still.
   */
  function startResizeRestore(): void {
    const scroller = transcriptRef.current;
    const windowEl = scroller?.querySelector<HTMLElement>(".transcript-window");
    if (!scroller || !windowEl) return;
    const windowTop = layoutTopWithin(windowEl, scroller);
    if (windowTop === null) return;
    cancelResizeRestore();
    // This restoration now covers the reading width it was started for, so the observer
    // does not start a second one for the same width.
    restoreReadingWidthRef.current = transcriptReadingWidth(scroller);
    const session = sessionRef.current;
    // Frozen before measure(), and never re-read from the live flags: the scroll events
    // the reset causes are not the user scrolling away, so they must not change which
    // position is being restored.
    const saved = stableViewportRef.current;
    const follow = saved?.follow ?? followingRef.current;
    const anchor = follow ? null : saved?.anchor ?? currentViewportAnchor(scroller, windowTop);
    followingRef.current = follow;
    setFollowing(follow);
    selfScrollingRef.current = true;
    // Mounted rows are remeasured at the new width. Keep offscreen measurements
    // rather than replacing the entire history with estimates during a resize.
    if (!follow && !anchor) {
      releaseResizeRestore();
      return;
    }
    let attempts = 0;
    let stableFrames = 0;
    let previous: {
      total: number;
      height: number;
      scrollHeight: number;
    } | null = null;
    const step = (): void => {
      restoreFrameRef.current = 0;
      const element = transcriptRef.current;
      if (!element || sessionRef.current !== session) {
        releaseResizeRestore();
        return;
      }
      attempts += 1;
      let waiting = false;
      let target = element.scrollHeight - element.clientHeight;
      if (!follow && anchor) {
        const index = blocksRef.current.findIndex(
          (block) => block.id === anchor.key,
        );
        if (index < 0) {
          releaseResizeRestore();
          return;
        }
        const row = virtualizer
          .getVirtualItems()
          .find((item) => item.index === index);
        if (row) {
          const slot = element.querySelector<HTMLElement>(`.transcript-slot[data-index="${index}"]`);
          if (slot) {
            const box = element.getBoundingClientRect();
            const scale = box.height / element.offsetHeight || 1;
            target = element.scrollTop + (slot.getBoundingClientRect().top - box.top) / scale - anchor.offset;
          } else {
            target = transcriptAnchorScrollTop(windowTop, row.start, anchor.offset);
            waiting = true;
          }
        } else {
          // The reset estimates can clamp the scroll position out of the anchored row's
          // range. Aim at where the virtualizer puts the row; the offset is corrected as
          // soon as it is mounted and measured again.
          const offset = virtualizer.getOffsetForIndex(index, "start");
          if (!offset) {
            releaseResizeRestore();
            return;
          }
          target = transcriptAnchorScrollTop(0, offset[0], anchor.offset);
          waiting = true;
        }
      }
      const wanted = Math.max(0, target);
      element.scrollTop = wanted;
      const total = virtualizer.getTotalSize();
      const remaining =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      const unchangedGeometry =
        previous !== null &&
        Math.abs(total - previous.total) <= 1 &&
        element.clientHeight === previous.height &&
        element.scrollHeight === previous.scrollHeight;
      previous = {
        total,
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
      };
      // Rows still carrying the estimate: the re-measurement has not finished, so the
      // positions and the total are still about to move.
      const sizes = new Map(
        virtualizer.getVirtualItems().map((item) => [item.index, item.size]),
      );
      let measuring = false;
      for (const slot of element.querySelectorAll<HTMLElement>(
        ".transcript-slot",
      )) {
        const recorded = sizes.get(Number(slot.dataset.index));
        if (recorded === undefined) continue;
        if (Math.abs(recorded - slot.offsetHeight) > 1) {
          measuring = true;
          break;
        }
      }
      const settled = transcriptRestoreSettled(
        {
          landed: Math.abs(element.scrollTop - wanted) <= 0.5,
          remaining,
          measuring,
          unchangedGeometry,
        },
        follow,
      );
      stableFrames = settled && !waiting ? stableFrames + 1 : 0;
      if (
        stableFrames >= RESTORE_STABLE_FRAMES ||
        attempts >= RESTORE_MAX_FRAMES
      ) {
        releaseResizeRestore();
        return;
      }
      restoreFrameRef.current = requestAnimationFrame(step);
    };
    restoreFrameRef.current = requestAnimationFrame(step);
  }

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    // Observing the reading column itself made every scrollbar flicker a resize: the
    // column is a percentage of the scroller's content box, so a scrollbar appearing or
    // disappearing shrank it by its width while the space the transcript was given -- the
    // thing text actually re-wraps against -- had not moved at all. Typing grows the
    // composer, the composer steals height from the transcript, and the scrollbar state
    // that depends on those two heights flickers; each flick ran a restoration, which is
    // what shook the blocks under the reader.
    //
    // So the observed width is the scroller's border box and nothing else changes it:
    // opening the inspector, resizing the window, or the layout settling at startup. A
    // reading width already under a restoration is not restarted either -- the restore in
    // flight is converging on the same position, and re-anchoring it mid-flight is what
    // made a restore run for as long as the user kept typing.
    let lastReadingWidth = transcriptReadingWidth(transcript);
    const observer = new ResizeObserver(() => {
      const element = transcriptRef.current;
      if (!element) return;
      const readingWidth = transcriptReadingWidth(element);
      const decision = transcriptRestoreWidthDecision(
        readingWidth,
        lastReadingWidth,
        restoreReadingWidthRef.current,
      );
      if (decision === "unchanged") return;
      lastReadingWidth = readingWidth;
      if (decision === "covered") return;
      restoreReadingWidthRef.current = readingWidth;
      // A resize is not the user scrolling away, so following must survive it: the reset
      // below briefly puts the scroll position far from the bottom, and the scroll events
      // that causes had been switching following off -- which then cancelled the restore
      // and left the view 1284px short at narrow widths. The restoration owns that
      // suppression itself and hands it back once it is done or the user takes over.
      startResizeRestore();
    });
    observer.observe(transcript);
    return () => {
      cancelResizeRestore();
      observer.disconnect();
    };
  }, [blocks.length, virtualizer]);

  useEffect(
    () => () => {
      window.clearTimeout(settleTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!revealItemId) return;
    const index = transcriptBlockIndexForItem(blocks, revealItemId);
    if (index < 0) return;
    // A search hit is usually not mounted, so it has to be scrolled to by index before
    // its element exists to highlight. Navigation wins over a pending restoration.
    cancelResizeRestore();
    followingRef.current = false;
    setFollowing(false);
    virtualizer.scrollToIndex(index, { align: "center" });
    let highlightFrame = 0;
    let removeTimer = 0;
    const highlight = window.setTimeout(() => {
      highlightFrame = requestAnimationFrame(() => {
        const target = document.getElementById(
          `transcript-${encodeURIComponent(revealItemId)}`,
        );
        if (!target) return;
        target.scrollIntoView({ block: "center" });
        target.classList.add("is-search-reveal");
        removeTimer = window.setTimeout(
          () => target.classList.remove("is-search-reveal"),
          2200,
        );
      });
      onRevealComplete?.(revealItemId);
    }, 60);
    return () => {
      window.clearTimeout(highlight);
      window.clearTimeout(removeTimer);
      cancelAnimationFrame(highlightFrame);
    };
  }, [blocks, onRevealComplete, revealItemId, virtualizer]);

  function updateScrollFollowing(): void {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    if (selfScrollingRef.current) return;
    const readingWidth = transcriptReadingWidth(transcript);
    if (stableViewportRef.current && stableViewportRef.current.width !== readingWidth) return;
    const nearBottom = shouldFollowTranscript(
      transcript.scrollHeight,
      transcript.scrollTop,
      transcript.clientHeight,
      scrolledAwayRef.current,
    );
    // Back at the bottom: the gesture is spent, so the slack for unmounted rows applies
    // again and new content resumes arriving in view. Not while it is still under way,
    // because its opening events report the position it started from.
    if (nearBottom && performance.now() - gestureAtRef.current > GESTURE_WINDOW_MS)
      scrolledAwayRef.current = false;
    followingRef.current = nearBottom;
    setFollowing(nearBottom);
    rememberViewport();

    // Only close a gap the user did not ask for. Scrolling up must stay put: an earlier
    // version force-enabled following whenever the last block was mounted, but overscan
    // keeps it mounted well past the viewport, so scrolling up switched following back on
    // and the view was dragged to the bottom 120ms later.
    if (!nearBottom) return;
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      const scroller = transcriptRef.current;
      if (!scroller || !followingRef.current) return;
      const remaining =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (remaining <= 1) return;
      selfScrollingRef.current = true;
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
      requestAnimationFrame(() => {
        selfScrollingRef.current = false;
      });
    }, 120);
  }

  function scrollToLatest(): void {
    cancelResizeRestore();
    followingRef.current = true;
    setFollowing(true);
    if (blocks.length === 0) return;
    // Scrolling by index rather than to scrollHeight: rows above are unmounted, so the
    // total height is still an estimate and a raw scrollTop lands short. Dragging the
    // scrollbar to the bottom hits the same problem, which is what the follow effect
    // below corrects.
    // Instant, not smooth: a smooth scroll makes the virtualizer defer measuring the rows
    // it passes, which is what left the first screen unmeasured and overlapping.
    virtualizer.scrollToIndex(blocks.length - 1, { align: "end" });
  }

  if (items.length === 0 && !compacting) {
    return (
      <div className="empty-conversation">
        <span className="empty-conversation__mark">
          <img src={gajaeIconUrl} alt="" />
        </span>
        <h2>Gajae에게 어떤 작업을 맡길까요?</h2>
      </div>
    );
  }

  return (
    <div
      className="transcript"
      aria-live="polite"
      ref={transcriptRef}
      onScroll={updateScrollFollowing}
      // Input direction carries intent. Upward means "reading older content" and
      // downward reverses it; the resulting position is indistinguishable from the
      // measurement slack that unmounted rows need.
      onWheel={(event) => {
        // Real input takes the view back from a resize restoration in flight.
        cancelResizeRestore();
        scrolledAwayRef.current = transcriptScrollIntent(
          scrolledAwayRef.current,
          event.deltaY,
        );
        if (event.deltaY < 0) gestureAtRef.current = performance.now();
        else if (event.deltaY > 0) gestureAtRef.current = 0;
      }}
      onTouchStart={(event) => {
        cancelResizeRestore();
        touchYRef.current = event.touches[0]?.clientY;
      }}
      onTouchMove={(event) => {
        cancelResizeRestore();
        const currentY = event.touches[0]?.clientY;
        const previousY = touchYRef.current;
        touchYRef.current = currentY;
        if (currentY === undefined || previousY === undefined) return;
        const deltaY = previousY - currentY;
        scrolledAwayRef.current = transcriptScrollIntent(
          scrolledAwayRef.current,
          deltaY,
        );
        if (deltaY < 0) gestureAtRef.current = performance.now();
        else if (deltaY > 0) gestureAtRef.current = 0;
      }}
      onTouchEnd={() => {
        touchYRef.current = undefined;
      }}
    >
      <div className="transcript-column">
        <div
          className="transcript-window"
          style={{ height: `${totalSize}px` }}
        >
          {virtualItems.map((virtualRow) => {
            const block = blocks[virtualRow.index];
            if (!block) return null;
            return (
              <div
                className="transcript-slot"
                data-index={virtualRow.index}
                data-last={virtualRow.index === blocks.length - 1 ? "true" : undefined}
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {block.kind === "item" ? (
                  <div
                    className="transcript-entry"
                    id={`transcript-${encodeURIComponent(block.item.id)}`}
                  >
                    <TranscriptItemView
                      item={block.item}
                      thoughtsExpanded={thoughtsExpanded}
                      onToggleThoughtsExpanded={onToggleThoughtsExpanded}
                      onResolveTool={onResolveTool}
                      onReadArtifact={onReadArtifact}
                    />
                  </div>
                ) : (
                  <div className="transcript-entry tool-run">
                    {block.items.map((tool) => (
                      <div
                        className="tool-run-entry"
                        id={`transcript-${encodeURIComponent(tool.id)}`}
                        key={tool.id}
                      >
                        <TranscriptItemView
                          item={tool}
                          thoughtsExpanded={thoughtsExpanded}
                          onToggleThoughtsExpanded={onToggleThoughtsExpanded}
                          onResolveTool={onResolveTool}
                          onReadArtifact={onReadArtifact}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {compacting && (
          <article className="compaction-card compaction-card--progress">
            <header>
              <Shrink size={15} />
              <strong>compaction</strong>
              <span>압축 중</span>
            </header>
            <p className="compaction-progress">
              <span className="mini-spinner" />
              세션 context를 압축하고 있습니다
            </p>
          </article>
        )}
      </div>
      {!following && (
        <button
          className="scroll-to-latest"
          type="button"
          onClick={scrollToLatest}
        >
          최신 내용으로
        </button>
      )}
    </div>
  );
}

export function CompactionCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "compaction" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const tokens = item.tokensBefore.toLocaleString("en-US");
  const preview = item.shortSummary || item.summary;
  return (
    <article className={`compaction-card ${expanded ? "is-expanded" : ""}`}>
      <header>
        <Shrink size={15} />
        <strong>compaction</strong>
        <span>{tokens} 토큰에서 압축됨</span>
      </header>
      <button
        type="button"
        className="compaction-toggle"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "요약 접기" : "요약 펼치기"}
      </button>
      {expanded ? (
        <div className="compaction-summary markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {item.summary}
          </ReactMarkdown>
        </div>
      ) : (
        preview && (
          <div className="compaction-short markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview}</ReactMarkdown>
          </div>
        )
      )}
    </article>
  );
}

export function BranchSummaryCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "branch_summary" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className={`compaction-card ${expanded ? "is-expanded" : ""}`}>
      <header>
        <GitFork size={15} />
        <strong>branch</strong>
        <span>분기 요약</span>
      </header>
      <button
        type="button"
        className="compaction-toggle"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "요약 접기" : "요약 펼치기"}
      </button>
      {expanded && (
        <div className="compaction-summary markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {item.summary}
          </ReactMarkdown>
        </div>
      )}
    </article>
  );
}

/**
 * A runtime notice, with the provenance the controller lane adds to injected activity.
 * Declared as an optional extension so this file renders both before and after that
 * contract change lands, and never reads as an assistant answer.
 */
type RuntimeNoticeActivity = Extract<TranscriptItem, { kind: "system" }> & {
  sourceType?: string;
  runtimeHidden?: boolean;
};

export function SystemNoticeCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "system" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  // The controller marks notices it injected from the runtime's own channel with a
  // source type and a hidden flag. Optional on purpose: a transcript that carries
  // neither renders exactly as before.
  const runtime: RuntimeNoticeActivity = item;
  const sourceType = runtime.sourceType?.trim();
  const lines = item.content.split("\n");
  const firstLine = lines.find((line) => line.trim().length > 0) ?? item.title;
  const preview = lines.slice(0, 3).join("\n");
  const truncated = item.content !== preview;
  // Injected channel activity -- IRC traffic and the other hidden custom messages the
  // CLI never shows as answers -- is not part of the conversation. One dim line per
  // message with the text on demand keeps the transcript readable; a card per message
  // buried the work between turns.
  if (runtime.runtimeHidden) {
    return (
      <article className="system-card system-card--runtime">
        <span className="runtime-row-source">{sourceType ?? item.title}</span>
        {expanded ? (
          <div className="system-card-body markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{
              item.content
            }</ReactMarkdown>
          </div>
        ) : (
          <span className="runtime-row-text" title={item.content}>
            {firstLine}
          </span>
        )}
        <button
          type="button"
          className="runtime-row-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "접기" : "더 보기"}
        </button>
      </article>
    );
  }
  return (
    <article className="system-card">
      <header>
        <TerminalSquare size={15} />
        <strong>{item.title}</strong>
        {sourceType && (
          <span className="system-card-provenance">{sourceType}</span>
        )}
      </header>
      <div className="system-card-body markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {expanded ? item.content : preview}
        </ReactMarkdown>
      </div>
      {truncated && (
        <button
          type="button"
          className="compaction-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "접기" : "더 보기"}
        </button>
      )}
    </article>
  );
}

// The todo card prints the runtime's own status vocabulary, so a status outside it is
// rendered as itself (and counted as other) rather than mapped onto one of these.
const TODO_STATUS_MARKERS = {
  in_progress: "◐",
  pending: "○",
  completed: "✓",
  abandoned: "⊘",
} as const;

const TODO_STATUS_LABELS = {
  in_progress: "in progress",
  pending: "pending",
  completed: "completed",
  abandoned: "abandoned",
} as const;

type TodoStatus = keyof typeof TODO_STATUS_MARKERS;

const TODO_STATUS_ORDER: readonly TodoStatus[] = [
  "in_progress",
  "pending",
  "completed",
  "abandoned",
];
const TODO_UNKNOWN_MARKER = "•";

// What the counts line can name, in the order it lists them. A status outside this list
// is counted at the end, as other.
const TODO_COUNT_KEYS: readonly (TodoStatus | "other")[] = [
  ...TODO_STATUS_ORDER,
  "other",
];

// A set rather than `in`: a status is data from the runtime, and `"constructor" in {}` is
// true, which would have classified a task named after a prototype key as a known status.
const TODO_STATUS_KEYS: ReadonlySet<string> = new Set(TODO_STATUS_ORDER);

function todoStatusKey(status: string | undefined): TodoStatus | undefined {
  const value = status?.trim().toLowerCase();
  return value && TODO_STATUS_KEYS.has(value) ? (value as TodoStatus) : undefined;
}

/**
 * The compact counts line: only the statuses the runtime actually reported, and a status
 * this window cannot name counted as other instead of being folded into one of the four.
 */
function todoCountsText(tasks: TodoSnapshotTask[]): string {
  const counts = new Map<TodoStatus | "other", number>();
  for (const task of tasks) {
    const key = todoStatusKey(task.status) ?? "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return TODO_COUNT_KEYS.flatMap((key) => {
    const value = counts.get(key) ?? 0;
    if (value === 0) return [];
    const label = key === "other" ? "other" : TODO_STATUS_LABELS[key];
    return [`${label} ${value}`];
  }).join(" · ");
}

/** 24-hour clock time of an observation, in the same format the controller labels
 * observations with. A stamp that does not parse labels nothing rather than throwing
 * inside a transcript row. */
function todoObservedLabel(observedAt: string | undefined): string {
  const parsed = observedAt ? Date.parse(observedAt) : Number.NaN;
  return Number.isFinite(parsed) ? TODO_CLOCK_LABEL.format(parsed) : "";
}

/**
 * The app-owned todo snapshot (`sourceType: "todo.list"`) as a checklist.
 *
 * The row used to render the controller's report of itself -- source, observation time,
 * how many records came back -- plus the snapshot's JSON, which said nothing about the
 * work. Each item is a row here, marked by the status the runtime gave it, and the
 * snapshot text stays behind 더 보기 so the record itself is not hidden.
 */
export function TodoCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "system" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  // A phase the runtime reported empty is dropped: it would be a heading with nothing
  // under it, and a snapshot with no items at all gets one line instead of a list.
  const phases = (item.todoPhases ?? []).filter(
    (phase) => (phase.tasks ?? []).length > 0,
  );
  const tasks = phases.flatMap((phase) => phase.tasks ?? []);
  const counts = todoCountsText(tasks);
  const observed = todoObservedLabel(item.observedAt);
  const source = item.sourceType?.trim() || "todo.list";
  const hasRaw = item.content.trim().length > 0;
  return (
    <article className="system-card todo-card">
      <header>
        <ListChecks size={15} />
        <strong>{item.title}</strong>
        {counts && <span className="todo-card-counts">{counts}</span>}
      </header>
      <div className="system-card-body todo-card-body">
        {tasks.length === 0 ? (
          <p className="todo-empty">
            No todos{observed ? ` · observed ${observed}` : ""}
          </p>
        ) : (
          <div className="todo-phases">
            {phases.map((phase, phaseIndex) => (
              <section
                className="todo-phase"
                key={`${phase.name ?? "phase"}-${phaseIndex}`}
              >
                {phase.name ? (
                  <h4 className="todo-phase-name">{phase.name}</h4>
                ) : null}
                <ul className="todo-tasks">
                  {phase.tasks.map((task, taskIndex) => {
                    const status = todoStatusKey(task.status);
                    return (
                      <li
                        className={`todo-task ${
                          status
                            ? `todo-task--${status}`
                            : "todo-task--unknown"
                        }`}
                        key={`${task.content}-${taskIndex}`}
                      >
                        <span className="todo-task-marker" aria-hidden>
                          {status ? TODO_STATUS_MARKERS[status] : TODO_UNKNOWN_MARKER}
                        </span>
                        <div className="todo-task-body">
                          <span className="todo-task-content">{task.content}</span>
                          {(task.notes ?? [])
                            .filter((note) => note.trim().length > 0)
                            .map((note, noteIndex) => (
                              <span
                                className="todo-task-note"
                                key={noteIndex}
                                title={note}
                              >
                                {note.split("\n")[0]}
                              </span>
                            ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
        {expanded && (
          <div className="todo-card-raw markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {item.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
      {hasRaw && (
        <button
          type="button"
          className="compaction-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "접기" : "더 보기"}
        </button>
      )}
      <footer className="todo-provenance">
        {observed ? `observed ${observed} · ${source}` : source}
      </footer>
    </article>
  );
}

/**
 * A reasoning card. Whether it is open is not the card's own business: the transcript
 * streams a card into existence and the runtime can re-send the same thought as a new
 * row, so a flag owned by the card was lost whenever the card was. The window-wide
 * preference is what makes one 펼치기/접기 click hold for every card.
 */
export function ThoughtCard({
  item,
  expanded,
  onToggle,
}: {
  item: Extract<TranscriptItem, { kind: "thought" }>;
  expanded: boolean;
  onToggle?: () => void;
}) {
  return (
    <article className={`thought-card ${item.streaming ? "is-streaming" : ""}`}>
      <header>
        <Brain size={15} />
        <strong>Gajae</strong>
        <span>{item.streaming ? "생각 중…" : "추론"}</span>
        {item.streaming && <span className="mini-spinner" />}
        {!item.streaming && (
          <button
            type="button"
            className="thought-toggle"
            onClick={onToggle}
          >
            {expanded ? "접기" : "펼치기"}
          </button>
        )}
      </header>
      {expanded && (
        <div
          className={`thought-content ${item.streaming ? "is-streaming" : "markdown-body"}`}
        >
          {item.streaming ? (
            item.content
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {item.content}
            </ReactMarkdown>
          )}
        </div>
      )}
    </article>
  );
}

export const TranscriptItemView = memo(function TranscriptItemView({
  item,
  thoughtsExpanded = false,
  onToggleThoughtsExpanded,
  onResolveTool,
  onReadArtifact,
}: {
  item: TranscriptItem;
  thoughtsExpanded?: boolean;
  onToggleThoughtsExpanded?: () => void;
  onResolveTool: TranscriptProps["onResolveTool"];
  onReadArtifact: TranscriptProps["onReadArtifact"];
}) {
  if (item.kind === "message") {
    const copyText = copyableMessageText(item.content);
    const attachments = attachmentSummaryText(item.content);
    return (
      <article className={`message message--${item.role}`}>
        {item.role === "assistant" && (
          <div className="message-author">
            <span className="assistant-mark">
              <img src={gajaeIconUrl} alt="" />
            </span>
            <strong>Gajae</strong>
            <time>{item.createdAt}</time>
          </div>
        )}
        {(item.content || item.streaming) && (
          <div
            className={`message-body ${item.role === "assistant" && !item.streaming ? "markdown-body" : ""}`}
          >
            {item.content ? (
              item.role === "assistant" ? (
                item.streaming ? (
                  item.content
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {item.content}
                  </ReactMarkdown>
                )
              ) : (
                copyText || item.content
              )
            ) : (
              <span className="typing-dots">
                <i />
                <i />
                <i />
              </span>
            )}
            {item.streaming && <span className="streaming-caret" />}
          </div>
        )}
        {item.images && item.images.length > 0 && (
          <div className="message-images">
            {item.images.map((image) => (
              <img
                key={image.id}
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={image.name}
                title={image.name}
              />
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <ul className="message-attachments">
            {attachments.map((name) => (
              <li key={name}>
                <Paperclip size={12} aria-hidden />
                <span>{name}</span>
              </li>
            ))}
          </ul>
        )}
        {item.role === "user" &&
          httpUrls(item.content).map((url) => (
            <LinkPreviewCard key={url} url={url} />
          ))}
        {item.role === "user" && (
          <div className="message-meta">
            <time className="user-time">{item.createdAt}</time>
            {copyText ? <MessageCopyButton text={copyText} /> : null}
          </div>
        )}
        {item.role === "assistant" && !item.streaming && copyText ? (
          <div className="message-meta message-meta--assistant">
            <MessageCopyButton text={copyText} />
          </div>
        ) : null}
      </article>
    );
  }

  if (item.kind === "notice") {
    return (
      <article className={`notice-card notice-card--${item.tone}`}>
        <Check size={16} />
        <span>
          <strong>{item.title}</strong>
          <small>{item.content}</small>
        </span>
      </article>
    );
  }

  if (item.kind === "compaction") {
    return <CompactionCard item={item} />;
  }

  if (item.kind === "branch_summary") {
    return <BranchSummaryCard item={item} />;
  }

  if (item.kind === "system") {
    // The app-owned todo row carries the store it was read from; a row without it is an
    // older record whose content is the only thing there is to show.
    if (item.sourceType?.trim() === "todo.list" && item.todoPhases) {
      return <TodoCard item={item} />;
    }
    return <SystemNoticeCard item={item} />;
  }

  if (item.kind === "thought") {
    return (
      <ThoughtCard
        item={item}
        expanded={thoughtsExpanded}
        onToggle={onToggleThoughtsExpanded}
      />
    );
  }

  if (item.kind === "plan") {
    return (
      <article className="plan-card">
        <header>
          <ListChecks size={15} />
          <strong>계획</strong>
          <span>
            {
              item.entries.filter((entry) => entry.status === "completed")
                .length
            }
            /{item.entries.length}
          </span>
        </header>
        <ol>
          {item.entries.map((entry, index) => (
            <li
              key={`${index}-${entry.content}`}
              className={`plan-entry--${entry.status}`}
            >
              <span />
              {entry.content}
            </li>
          ))}
        </ol>
      </article>
    );
  }

  return (
    <ToolCard
      tool={item}
      onResolve={onResolveTool}
      onReadArtifact={onReadArtifact}
    />
  );
});

export interface ToolCardProps {
  tool: ToolActivity;
  onResolve: (toolId: string, optionId: string) => void;
  onReadArtifact?: (artifactId: string) => Promise<ArtifactContent>;
}

export function ToolCard({ tool, onResolve, onReadArtifact }: ToolCardProps) {
  const approvalRequired = tool.status === "approval-required";
  const [expanded, setExpanded] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactContent | null>(null);
  const [artifactError, setArtifactError] = useState("");
  const command = tool.command ? compactToolCommand(tool.command) : undefined;
  const output = tool.output
    ? compactToolText(humanRuntimeText(tool.output))
    : undefined;
  const hasDetails = Boolean(command?.fullText || output?.fullText);
  return (
    <>
      <div className="activity-progress">
        <strong>gajae</strong>
        <span>{tool.description}</span>
      </div>
      <article
        className={`tool-card ${approvalRequired ? "tool-card--approval" : ""}`}
      >
        <header>
          <span className="tool-icon">
            <TerminalSquare size={16} />
          </span>
          <span>
            <strong>{toolDisplayName(tool.name)}</strong>
            <small>{tool.description}</small>
          </span>
          <span className={`tool-status tool-status--${tool.status}`}>
            {tool.status === "running" && <span className="mini-spinner" />}
            {toolStatusLabel(tool.status)}
          </span>
        </header>
        {tool.subagents && tool.subagents.length > 0 && (
          <div className="tool-full-details">
            <section>
              <strong>요청된 서브에이전트</strong>
              {/* What the call asked for, not what those agents are doing now: their
                  status is inferred from the parent and is not authoritative here. */}
              {tool.subagents.map((subagent) => (
                <p key={subagent.id}>
                  {subagent.label}
                  {subagent.role ? ` · ${subagent.role}` : ""}
                  {subagent.objective ? ` — ${subagent.objective}` : ""}
                </p>
              ))}
            </section>
          </div>
        )}
        {command?.preview && <code>{command.preview}</code>}
        {tool.diff && <DiffView diff={tool.diff} path={tool.targetPath} />}
        {tool.images?.map((image, index) => (
          <img
            key={`${tool.id}-image-${index}`}
            className="tool-image"
            src={image.dataUrl}
            alt={tool.targetPath ?? "도구가 읽은 이미지"}
          />
        ))}
        {!tool.diff && output?.text && (
          <div className="tool-output-preview">
            {output.omittedLines > 0 && (
              <small>앞부분 {output.omittedLines}줄 생략</small>
            )}
            <pre>{output.text}</pre>
          </div>
        )}
        {hasDetails && (
          <button
            className="tool-expand"
            type="button"
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "상세 내용 닫기" : "상세 내용 보기"}{" "}
            <ChevronDown size={12} />
          </button>
        )}
        {expanded && (
          <div className="tool-full-details">
            {command?.fullText && (
              <section>
                <strong>입력</strong>
                <pre>{command.fullText}</pre>
              </section>
            )}
            {output?.fullText && (
              <section>
                <strong>출력</strong>
                <pre>{output.fullText}</pre>
              </section>
            )}
          </div>
        )}
        {(tool.inputArtifactId ||
          tool.outputArtifactId ||
          tool.artifactRefs?.length) && (
          <div className="artifact-links">
            {[
              tool.inputArtifactId,
              tool.outputArtifactId,
              ...(tool.artifactRefs ?? []),
            ]
              .filter((id): id is string => Boolean(id))
              .map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    if (!onReadArtifact) return;
                    setArtifactError("");
                    void onReadArtifact(id)
                      .then(setArtifact)
                      .catch((e) =>
                        setArtifactError(
                          e instanceof Error ? e.message : String(e),
                        ),
                      );
                  }}
                >
                  {id.startsWith("artifact://") ? id : `artifact://${id}`}
                </button>
              ))}
          </div>
        )}
        {artifactError && (
          <small className="artifact-error">{artifactError}</small>
        )}
        {artifact && (
          <div className="tool-full-details">
            <section>
              <strong>
                Artifact {artifact.artifactId}{" "}
                {artifact.complete ? "" : "(미완료)"}
              </strong>
              <pre>{artifact.text}</pre>
              <small>
                {artifact.complete
                  ? "전체 내용"
                  : `일부만 로드됨 · ${artifact.totalBytes} bytes`}
              </small>
            </section>
          </div>
        )}
        {approvalRequired && (
          <footer>
            <span>
              <ShieldCheck size={14} /> 승인이 필요합니다
            </span>
            <div className="permission-options">
              {(tool.permissionOptions ?? []).map((option) => (
                <button
                  key={option.optionId}
                  type="button"
                  className={
                    option.kind.startsWith("reject")
                      ? "button-secondary"
                      : "button-primary"
                  }
                  onClick={() => onResolve(tool.id, option.optionId)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          </footer>
        )}
      </article>
    </>
  );
}

export function RecentRequestStrip({
  items,
  onReveal,
}: {
  items: TranscriptItem[];
  onReveal: (id: string) => void;
}) {
  const requests = useMemo(() => recentUserRequests(items), [items]);
  if (requests.length === 0) return null;
  return (
    <section className="recent-requests" aria-label="최근 요청">
      <header>
        <Clock3 size={11} />
        <strong>최근 요청</strong>
      </header>
      <div>
        {requests.map((request, index) => (
          <button
            type="button"
            key={request.id}
            title={request.text}
            onClick={() => onReveal(request.id)}
          >
            <span>{index + 1}</span>
            <strong>{request.text}</strong>
            <time>{request.createdAt}</time>
          </button>
        ))}
      </div>
    </section>
  );
}
