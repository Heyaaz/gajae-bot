import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import type { ArtifactContent } from "../../shared/agent-contract";
import type { QuestionSubmission, ToolViewMode, TranscriptItem } from "../backend/types";
import type { MessageDeliveryAttempt } from "../message-delivery";
import {
  deliveryAttemptNeedsAttention,
  deliveryEchoMatches,
  messageDeliveryRequestText,
} from "../message-delivery";
import { QuestionCard } from "./question-card";
import {
  appendProgressBlock,
  attachmentSummaryText,
  copyableMessageText,
  groupTranscriptItems,
  parseSkillInvocation,
  resolveTurnProgress,
  summarizeToolRun,
  toolRunCollapsed,
  type ToolRunManualState,
  TRANSCRIPT_BOTTOM_EPSILON_PX as BOTTOM_EPSILON_PX,
  transcriptBlockIndexForItem,
  transcriptRowEstimate,
  turnStartBlockIds,
  type StoredTurnClock,
  type TurnSessionHint,
} from "../transcript-utils";
import { GajaeProgressRow } from "./gajae-progress";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Brain,
  Check,
  FolderGit2,
  ListChecks,
  Paperclip,
  TerminalSquare,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { directoryName, httpUrls } from "./format";
import { LinkPreviewCard, MessageCopyButton } from "./primitives";
import { SkillInvocation, SkillPromptCard } from "./skill-activity";
import { t, useLanguage } from "../i18n";
import {
  BranchSummaryCard,
  CompactionCard,
  MessageDeliveryRow,
  SystemNoticeCard,
} from "./transcript-cards";
import { MarkdownBody, StreamingMarkdown } from "./transcript-markdown";
import {
  GESTURE_WINDOW_MS,
  LATEST_SETTLE_MAX_FRAMES,
  RESTORE_MAX_FRAMES,
  RESTORE_STABLE_FRAMES,
  layoutTopWithin,
  transcriptAnchorScrollTop,
  transcriptFollowDecision,
  transcriptGestureClaimsView,
  transcriptReadingWidth,
  transcriptRestoreSettled,
  transcriptRestoreWidthDecision,
  transcriptViewportAnchor,
  type TranscriptAnchorRow,
  type TranscriptViewportAnchor,
} from "./transcript-scroll";
import { TodoCard } from "./transcript-todo";
import { ToolCard } from "./transcript-tool-card";
export { BranchSummaryCard, CompactionCard, SystemNoticeCard } from "./transcript-cards";
export {
  ApprovalBanner,
  ConversationFindBar,
  RecentRequestStrip,
  type ApprovalBannerProps,
  type ConversationFindBarProps,
} from "./transcript-overlays";
export {
  GESTURE_WINDOW_MS,
  transcriptAnchorScrollTop,
  transcriptFollowDecision,
  transcriptGestureClaimsView,
  transcriptRestoreSettled,
  transcriptRestoreWidthDecision,
  transcriptViewportAnchor,
  type TranscriptAnchorRow,
  type TranscriptViewportAnchor,
} from "./transcript-scroll";
export { TodoCard } from "./transcript-todo";
export { ToolCard, type ToolCardProps } from "./transcript-tool-card";

export interface TranscriptProps {
  sessionId: string;
  items: TranscriptItem[];
  hasMoreBefore?: boolean;
  loadingEarlier?: boolean;
  loadEarlierError?: string;
  loadingPage?: boolean;
  pageLoadError?: string;
  onRetryPage?: () => void;
  onLoadEarlier?: (anchor: TranscriptViewportAnchor | null) => void | Promise<void>;
  onReturnToLatest?: () => void;
  deliveryAttempts?: MessageDeliveryAttempt[];
  onRetryDelivery?: (attemptId: string) => void;
  /**
   * Bumped by the shell every time this window sends a request into the open session.
   *
   * The reader who just pressed Enter asked for the answer, so the view has to be at the
   * newest content when it arrives. A counter rather than something compared against the
   * transcript: a durable rebuild replaces a live row with its stored twin and can hand
   * the same request a new id, which would look like a fresh send and move a view the
   * user had deliberately scrolled away from.
   */
  sentRequestToken?: number;
  /** Session row the progress emoticon reads. Absent on a session with no row. */
  turnSession?: TurnSessionHint | null;
  compacting?: boolean;
  /** The persisted, window-wide reasoning-card preference. */
  thoughtsExpanded?: boolean;
  onToggleThoughtsExpanded?: () => void;
  /**
   * Tool-run display density.
   *
   * `basic` collapses a tool-run block to a one-line summary (expanding only on
   * demand, or automatically when the run holds a failure or a pending approval).
   * `reasoning` and `detailed` both render every tool card; `detailed` additionally
   * forces reasoning cards open regardless of `thoughtsExpanded`, absorbing that
   * global toggle rather than requiring a second one.
   */
  toolViewMode?: ToolViewMode;
  revealItemId?: string;
  onRevealComplete?: (itemId: string) => void;
  onResolveTool: (toolId: string, optionId: string) => void;
  onAnswerQuestion?: (
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ) => void;
  onReadArtifact?: (artifactId: string) => Promise<ArtifactContent>;
  /**
   * The auto-deny hint shown on every denied tool call, when the session's
   * permission mode (not a user's own reject decision) is what denied it.
   */
  autoDenyHint?: { message: string; onOpenSettings?: () => void };
  /** Retries the session's own last user request, from a run-failure notice's 다시 시도 button. */
  onRetryLastRequest?: (sessionId: string) => void;
  onRevealInspector?: (toolId: string) => void;
  /** What the empty-conversation state shows about the session it is about to run in. */
  emptyStateMeta?: {
    workspace: string;
    modelDisplay?: string;
    recentWorkspaces: string[];
    onWorkspaceChange?: (workspace: string) => void;
  };
}

export function Transcript({
  sessionId,
  items,
  hasMoreBefore = false,
  loadingEarlier = false,
  loadEarlierError = "",
  loadingPage = false,
  pageLoadError = "",
  onRetryPage,
  onLoadEarlier,
  onReturnToLatest,
  deliveryAttempts = [],
  onRetryDelivery,
  sentRequestToken = 0,
  turnSession = null,
  compacting = false,
  thoughtsExpanded = false,
  onToggleThoughtsExpanded,
  toolViewMode = "reasoning",
  revealItemId,
  onRevealComplete,
  onResolveTool,
  onAnswerQuestion,
  onReadArtifact,
  autoDenyHint,
  onRetryLastRequest,
  emptyStateMeta,
  onRevealInspector,
}: TranscriptProps) {
  // `detailed` absorbs the reasoning toggle: it always shows thought cards open
  // regardless of the persisted preference, rather than requiring a second control.
  const effectiveThoughtsExpanded = toolViewMode === "detailed" || thoughtsExpanded;
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
  // Set by a wheel or touch gesture that took the view off the newest content, and cleared
  // only once the view has arrived back at it. The scroll position cannot carry this on its
  // own: one notch is ~109px, which is inside the slack that unmounted rows require, so a
  // small scroll read as "still at the bottom" and was pulled straight back -- net movement
  // 0px. It is deliberately direction-agnostic: a scroll back down a little is a position
  // on the way to the newest content, not permission to follow it again.
  const scrolledAwayRef = useRef(false);
  // When the last upward gesture happened -- the shape of claim whose own opening scroll events
  // report the bottom it is leaving. Those events read as "arrived" before the gesture has
  // moved anything, which would erase the claim that took the view, so a claim stays in force
  // over them until the scrolling it caused has stopped. A downward claim is away from the
  // bottom by definition (that is why it claimed), and the position it is heading for is the
  // bottom: arriving there is a real arrival, and stamping this would delay it by the window
  // while the corrections stood down behind a claim the user had already spent.
  const gestureAtRef = useRef(0);
  // Where an upward gesture started. The window exists so that gesture's own opening
  // events cannot cancel it. When the window ends, a landing that never left the
  // bottom epsilon is not reading, even if content grew underneath and no further
  // scroll event asked again.
  const gestureLandingRef = useRef<{ scrollTop: number; remaining: number } | null>(null);
  const gestureReleaseTimerRef = useRef(0);
  const touchYRef = useRef<number | undefined>(undefined);
  const sessionRef = useRef(sessionId);
  // Frames of the in-flight resize restoration, so a gesture, a session switch, or the
  // next resize can take it over instead of a stale correction landing on top of it.
  const restoreFrameRef = useRef(0);
  // Frames of the in-flight hand-back to the newest content, for the same reason.
  const latestFrameRef = useRef(0);
  const revealFrameRef = useRef(0);
  const revealGenerationRef = useRef(0);
  // Set while this view is deliberately on its way to the newest content, which is the
  // one thing the position cannot say for itself: mid-flight it sits short of the bottom
  // it is heading for, and every consumer of the position reads that as a reader who
  // took the view. It has to be its own flag rather than `selfScrollingRef`, which the
  // follow chase clears in its effect cleanup -- the request's own row is what re-runs
  // that effect, so the cleanup landed inside the hand-back and left every one of its
  // writes unclaimed. Measured: the chase read them as a gesture, stood itself down, and
  // left the view 376px above the request that had just been sent.
  const handingBackRef = useRef(false);
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
  const pendingPrependRef = useRef<{
    sessionId: string;
    firstId: string | undefined;
    itemCount: number;
  } | null>(null);
  const earlierRequestSessionRef = useRef<{ sessionId: string } | null>(null);
  const [following, setFollowing] = useState(true);
  const [atHistoryStart, setAtHistoryStart] = useState(false);
  // The send this view has already answered for. Seeded with the token it mounted with so
  // opening a session is not read as a request that was just typed.
  const answeredSendRef = useRef(sentRequestToken);

  // Pending text prompts already have a local echo in `items`; rendering the
  // attempt as a second row duplicated the message while its delivery was being
  // confirmed. Only actionable outcomes replace the echo. Attachment-only sends
  // have no echo, so those keep their pending row (without a status line).
  const attentionAttempts = useMemo(
    () => deliveryAttempts.filter(deliveryAttemptNeedsAttention),
    [deliveryAttempts],
  );
  const pendingWithoutEcho = useMemo(
    () =>
      deliveryAttempts.filter(
        (attempt) =>
          !deliveryAttemptNeedsAttention(attempt) &&
          !messageDeliveryRequestText(attempt.input),
      ),
    [deliveryAttempts],
  );
  const renderedAttempts = useMemo(
    () => [...attentionAttempts, ...pendingWithoutEcho],
    [attentionAttempts, pendingWithoutEcho],
  );
  const visibleItems = useMemo(() => {
    return items.filter((item) => {
      if (item.kind !== "message" || item.role !== "user" || !item.id.startsWith("local-prompt-"))
        return true;
      return !attentionAttempts.some((attempt) =>
        deliveryEchoMatches(attempt.input, item),
      );
    });
  }, [attentionAttempts, items]);
  const grouped = useMemo(() => groupTranscriptItems(visibleItems), [visibleItems]);
  const turnStarts = useMemo(() => turnStartBlockIds(grouped), [grouped]);
  // One clock per session, kept across renders so a streaming answer can hide the
  // row without forgetting when the turn started. The row itself only ticks a
  // text node; this memo runs when the transcript or the session status changes.
  const turnClockRef = useRef(new Map<string, StoredTurnClock>());
  const turnStatus = turnSession?.status;
  const turnPhase = turnSession?.phase;
  const retryProgress = useCallback(() => {
    onRetryLastRequest?.(sessionId);
  }, [onRetryLastRequest, sessionId]);
  const rows = useMemo(() => {
    const previous = turnClockRef.current.get(sessionId);
    const resolved = resolveTurnProgress(
      items,
      { status: turnStatus, phase: turnPhase },
      sessionId,
      previous,
      Date.now(),
    );
    if (resolved.stored) turnClockRef.current.set(sessionId, resolved.stored);
    else turnClockRef.current.delete(sessionId);
    const blocks = appendProgressBlock(grouped, resolved.progress);
    return [
      ...blocks,
      ...renderedAttempts.map((attempt) => ({
          kind: "delivery" as const,
          id: `delivery:${attempt.id}`,
          attempt,
        })),
    ];
  }, [renderedAttempts, grouped, items, sessionId, turnPhase, turnStatus]);
  // The restoration runs across frames and has to name the anchored block, so it reads the
  // current blocks rather than the ones its effect closed over.
  const blocksRef = useRef(rows);
  useLayoutEffect(() => {
    blocksRef.current = rows;
  }, [rows]);

  // Only the blocks near the viewport are mounted. A full session used to keep ~800
  // entries and 20,000 nodes live, which made every width change -- opening the detail
  // panel, resizing the window -- re-wrap and re-measure the whole document in one
  // frame. Estimates are refined by measuring each row as it mounts.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => transcriptRef.current,
    estimateSize: (index) =>
      transcriptRowEstimate(rows[index]?.kind === "progress" ? "progress" : "item"),
    // offsetHeight, not getBoundingClientRect: the rect is scaled by the window's zoom
    // level while the offsets the virtualizer positions rows with are not. At 110% zoom
    // every row was recorded 10% too tall (941px measured as 1035px), so the reserved
    // space exceeded the content and left a ragged 11-104px gap between blocks.
    //
    // No margin arithmetic either: the slot owns the gap between blocks as padding, which
    // is already inside this box. Reading margins off the cards double counted the spacing
    // -- once in the measured height, again in layout -- for gaps of -154px to +81px.
    measureElement: (element) => (element as HTMLElement).offsetHeight,
    getItemKey: (index) => rows[index]?.id ?? index,
    // Rows are only measured once mounted, and a row's real height runs from 61px to
    // 1415px against a single estimate. Too small an overscan and the rows arriving at the
    // bottom edge get positioned on the estimate before they are measured, so they
    // overlapped the row above by up to 445px. A screenful of slack ahead means they are
    // mounted and measured before they matter.
    overscan: 12,
  });

  const virtualItems = virtualizer.getVirtualItems();

  useLayoutEffect(() => {
    const pending = pendingPrependRef.current;
    if (!pending) return;
    if (pending.sessionId !== sessionId) {
      pendingPrependRef.current = null;
      return;
    }
    if (items[0]?.id === pending.firstId && items.length <= pending.itemCount)
      return;
    pendingPrependRef.current = null;
    startResizeRestore();
  }, [items, rows.length, virtualizer]);

  function rememberViewport(): void {
    const scroller = transcriptRef.current;
    const content = scroller?.querySelector<HTMLElement>(".transcript-window");
    if (!scroller || !content || restoreFrameRef.current || selfScrollingRef.current || handingBackRef.current || resizePreparedRef.current) return;
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

  useEffect(() => {
    const prepare = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('[data-session-info], .inspector header button')) return;
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
    cancelHandBack();
    sessionRef.current = sessionId;
    setAtHistoryStart(false);
    stableViewportRef.current = null;
    followingRef.current = true;
    scrolledAwayRef.current = false;
    gestureAtRef.current = 0;
    gestureLandingRef.current = null;
    window.clearTimeout(gestureReleaseTimerRef.current);
    gestureReleaseTimerRef.current = 0;
    touchYRef.current = undefined;
    selfScrollingRef.current = true;
    setFollowing(true);
    virtualizer.measure();
    if (rows.length > 0)
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    const frame = requestAnimationFrame(() => {
      const element = transcriptRef.current;
      if (element && followingRef.current)
        element.scrollTop = element.scrollHeight - element.clientHeight;
      selfScrollingRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [rows.length, sessionId, virtualizer]);

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
  // Re-run when the transcript changes too: `virtualItems` stays memoized while a row
  // grows, so a streaming reply would otherwise keep its old height and place the next
  // prompt inside it. useLayoutEffect so this lands before the browser paints the bad
  // positions.
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
  }, [rows, virtualItems, virtualizer]);

  const totalSize = virtualizer.getTotalSize();

  useEffect(() => {
    if (!followingRef.current || rows.length === 0) return;
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
      if (selfScrollingRef.current || handingBackRef.current) return;
      const element = transcriptRef.current;
      if (
        element &&
        element.scrollHeight - element.scrollTop - element.clientHeight <=
          BOTTOM_EPSILON_PX
      )
        return;
      interrupted = true;
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
        // A foreign event can be the tail of the gesture that just landed on the
        // bottom. Re-read the position instead of freezing following off: the chip
        // stayed on screen after the user was already at the newest content.
        updateScrollFollowing();
        return;
      }
      // A gesture that claimed the view while this correction was pending owns it. The
      // correction stands down without writing: the write lands on the bottom the gesture is
      // scrolling away from, and aborting the browser's own scroll animation is what left a
      // wheel notch worth 0px of movement.
      if (scrolledAwayRef.current) {
        selfScrollingRef.current = false;
        return;
      }
      // Marked as our own scroll: mid-correction the position is legitimately short of the
      // bottom, and letting the scroll handler judge that would clear the follow flag and
      // cancel this.
      selfScrollingRef.current = true;
      element.scrollTop = element.scrollHeight - element.clientHeight;
      attempts += 1;
      const settled =
        element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_EPSILON_PX;
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
  }, [rows.length, items]);

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

  function loadEarlier(): void {
    if (
      !hasMoreBefore ||
      loadingEarlier ||
      !onLoadEarlier ||
      earlierRequestSessionRef.current?.sessionId === sessionId
    )
      return;
    const request = { sessionId };
    earlierRequestSessionRef.current = request;
    const scroller = transcriptRef.current;
    const content = scroller?.querySelector<HTMLElement>(".transcript-window");
    const windowTop = scroller && content ? layoutTopWithin(content, scroller) : null;
    const anchor = scroller && windowTop !== null
      ? currentViewportAnchor(scroller, windowTop)
      : null;
    if (scroller && windowTop !== null) {
      stableViewportRef.current = {
        width: transcriptReadingWidth(scroller),
        follow: false,
        anchor,
      };
    }
    pendingPrependRef.current = {
      sessionId,
      firstId: items[0]?.id,
      itemCount: items.length,
    };
    followingRef.current = false;
    scrolledAwayRef.current = true;
    setFollowing(false);
    void Promise.resolve(onLoadEarlier(anchor)).catch(() => undefined).finally(() => {
      if (earlierRequestSessionRef.current === request)
        earlierRequestSessionRef.current = null;
      requestAnimationFrame(() => {
        if (pendingPrependRef.current?.firstId === items[0]?.id &&
            pendingPrependRef.current.itemCount === items.length)
          pendingPrependRef.current = null;
      });
    });
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

  /** Drop a hand-back in flight: a gesture, a session switch, or a re-anchor owns the view now. */
  function cancelHandBack(): void {
    if (latestFrameRef.current !== 0) {
      cancelAnimationFrame(latestFrameRef.current);
      latestFrameRef.current = 0;
    }
    handingBackRef.current = false;
  }

  function cancelReveal(): void {
    revealGenerationRef.current += 1;
    if (revealFrameRef.current !== 0) {
      cancelAnimationFrame(revealFrameRef.current);
      revealFrameRef.current = 0;
    }
    selfScrollingRef.current = false;
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
  }, [rows.length, virtualizer]);

  useEffect(
    () => () => {
      window.clearTimeout(settleTimerRef.current);
      window.clearTimeout(gestureReleaseTimerRef.current);
      cancelAnimationFrame(latestFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!revealItemId) return;
    const index = transcriptBlockIndexForItem(grouped, revealItemId);
    if (index < 0) return;
    // A search hit is usually not mounted, so it has to be scrolled to by index before
    // its element exists to highlight. Navigation wins over a pending restoration.
    earlierRequestSessionRef.current = null;
    pendingPrependRef.current = null;
    cancelResizeRestore();
    cancelHandBack();
    gestureLandingRef.current = null;
    followingRef.current = false;
    scrolledAwayRef.current = true;
    gestureAtRef.current = performance.now();
    setFollowing(false);
    selfScrollingRef.current = true;
    const generation = ++revealGenerationRef.current;
    let attempts = 0;
    const reveal = (): void => {
      revealFrameRef.current = 0;
      if (revealGenerationRef.current !== generation) return;
      virtualizer.scrollToIndex(index, { align: "center" });
      const target = document.getElementById(`transcript-${encodeURIComponent(revealItemId)}`);
      const scroller = transcriptRef.current;
      if (target && scroller) {
        const targetBox = target.getBoundingClientRect();
        const viewport = scroller.getBoundingClientRect();
        scroller.scrollTop += targetBox.top - viewport.top - Math.max(0, (viewport.height - targetBox.height) / 2);
      }
      // A newly selected page initially carries estimated heights from the previous
      // window. Keep the target anchored while mounted rows acquire real heights.
      attempts += 1;
      if (attempts < 12) {
        revealFrameRef.current = requestAnimationFrame(reveal);
      } else {
        selfScrollingRef.current = false;
        rememberViewport();
        if (target) {
          target.classList.add("is-search-reveal");
          window.setTimeout(() => target.classList.remove("is-search-reveal"), 2200);
        }
        onRevealComplete?.(revealItemId);
      }
    };
    revealFrameRef.current = requestAnimationFrame(reveal);
    return () => {
      if (revealGenerationRef.current === generation) cancelReveal();
    };
  }, [grouped, onRevealComplete, revealItemId, virtualizer]);

  // A wheel, a trackpad swipe, or a touch drag over the transcript. Direction decides who
  // owns the view, never the distance to the bottom -- see transcriptGestureClaimsView.
  function noteGesture(deltaY: number): void {
    const scroller = transcriptRef.current;
    const remaining = scroller
      ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      : 0;
    if (!transcriptGestureClaimsView(deltaY, remaining)) return;
    cancelReveal();
    // A gesture that takes the view ends a hand-back: the position this is heading for
    // is the one the reader is leaving.
    cancelHandBack();
    scrolledAwayRef.current = true;
    // Only the upward claim needs the window; see gestureAtRef.
    if (deltaY < 0) {
      gestureAtRef.current = performance.now();
      gestureLandingRef.current = {
        scrollTop: scroller?.scrollTop ?? 0,
        remaining,
      };
      window.clearTimeout(gestureReleaseTimerRef.current);
      gestureReleaseTimerRef.current = window.setTimeout(() => {
        gestureReleaseTimerRef.current = 0;
        updateScrollFollowing(true);
      }, GESTURE_WINDOW_MS);
    }
  }

  function updateScrollFollowing(gestureWindowEnded = false): void {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    if (selfScrollingRef.current || handingBackRef.current) return;
    const readingWidth = transcriptReadingWidth(transcript);
    if (stableViewportRef.current && stableViewportRef.current.width !== readingWidth) return;
    // onScroll passes the event as the first argument. Only an explicit true from the
    // gesture-window timer means the window ended; a truthy event must not.
    const windowEnded = gestureWindowEnded === true;
    const landing = gestureLandingRef.current;
    if (windowEnded) gestureLandingRef.current = null;
    const heldAtBottom =
      windowEnded &&
      landing !== null &&
      landing.remaining <= BOTTOM_EPSILON_PX &&
      Math.abs(transcript.scrollTop - landing.scrollTop) <= BOTTOM_EPSILON_PX;
    const decision = heldAtBottom
      ? { reading: false, following: true }
      : transcriptFollowDecision({
          scrollHeight: transcript.scrollHeight,
          scrollTop: transcript.scrollTop,
          clientHeight: transcript.clientHeight,
          reading: scrolledAwayRef.current,
          gestureAgeMs: windowEnded
            ? GESTURE_WINDOW_MS
            : performance.now() - gestureAtRef.current,
        });
    scrolledAwayRef.current = decision.reading;
    followingRef.current = decision.following;
    setFollowing(decision.following);
    rememberViewport();

    // Only close a gap the user did not ask for. Reading must stay put: an earlier version
    // force-enabled following whenever the last block was mounted, but overscan keeps it
    // mounted well past the viewport, so scrolling up switched following back on and the
    // view was dragged to the bottom 120ms later.
    if (!decision.following) return;
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      const scroller = transcriptRef.current;
      // Re-read instead of trusting the reading this was armed from: 120ms is long enough
      // for a gesture to arrive, and a claimed view is the user's own statement that the
      // position must not move on its own.
      if (!scroller || !followingRef.current || scrolledAwayRef.current) return;
      const remaining =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (remaining <= BOTTOM_EPSILON_PX) return;
      selfScrollingRef.current = true;
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
      requestAnimationFrame(() => {
        selfScrollingRef.current = false;
      });
    }, 120);
  }

  // Sending a request hands the view back to the newest content. Everything the runtime
  // streams afterwards follows it until the reader scrolls away again -- that gesture is
  // the one that takes the view, and it is what already stands down the corrections.
  useEffect(() => {
    if (answeredSendRef.current === sentRequestToken) return;
    answeredSendRef.current = sentRequestToken;
    scrollToLatest();
  }, [sentRequestToken]);

  function scrollToLatest(): void {
    cancelReveal();
    earlierRequestSessionRef.current = null;
    pendingPrependRef.current = null;
    cancelResizeRestore();
    followingRef.current = true;
    setFollowing(true);
    // The one action that hands the view back from outside the position. The user asked for
    // the newest content, so the reading intent and its gesture window go with the request.
    scrolledAwayRef.current = false;
    gestureAtRef.current = 0;
    gestureLandingRef.current = null;
    window.clearTimeout(gestureReleaseTimerRef.current);
    gestureReleaseTimerRef.current = 0;
    cancelHandBack();
    if (rows.length === 0) return;
    // Scrolling by index rather than to scrollHeight: rows above are unmounted, so the
    // total height is still an estimate and a raw scrollTop lands short. Dragging the
    // scrollbar to the bottom hits the same problem, which is what the follow effect
    // below corrects.
    // Instant, not smooth: a smooth scroll makes the virtualizer defer measuring the rows
    // it passes, which is what left the first screen unmeasured and overlapping.
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    // One write is not the hand-back: it lands on a bottom that is still an estimate, and
    // the layout keeps moving under it -- the composer gives back the height it held for
    // the draft, and the rows the request appended are measured into place. A single
    // settled frame was measured exiting after 15ms with the viewport still 379 of its
    // eventual 477px tall, after which the compensation walked the view 472px back up.
    // So the write is repeated until the geometry itself holds still, exactly the way a
    // resize restoration finishes, and the claim over those writes outlives the chase
    // effect's cleanup.
    handingBackRef.current = true;
    let attempts = 0;
    let stableFrames = 0;
    let previous: { total: number; height: number; scrollHeight: number } | null = null;
    const settle = (): void => {
      latestFrameRef.current = 0;
      const scroller = transcriptRef.current;
      attempts += 1;
      if (
        !scroller ||
        !followingRef.current ||
        scrolledAwayRef.current ||
        attempts > LATEST_SETTLE_MAX_FRAMES
      ) {
        finish();
        return;
      }
      const wanted = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = wanted;
      const geometry = {
        total: virtualizer.getTotalSize(),
        height: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
      };
      const unchangedGeometry =
        previous !== null &&
        Math.abs(geometry.total - previous.total) <= 1 &&
        geometry.height === previous.height &&
        geometry.scrollHeight === previous.scrollHeight;
      previous = geometry;
      const landed =
        Math.abs(scroller.scrollTop - wanted) <= 0.5 &&
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_EPSILON_PX;
      stableFrames = landed && unchangedGeometry ? stableFrames + 1 : 0;
      if (stableFrames >= RESTORE_STABLE_FRAMES) {
        finish();
        return;
      }
      latestFrameRef.current = requestAnimationFrame(settle);
    };
    const finish = (): void => {
      handingBackRef.current = false;
      // The position has the last word: a hand-back that could not reach the newest
      // content must not leave the button that asks for it hidden.
      updateScrollFollowing();
    };
    latestFrameRef.current = requestAnimationFrame(settle);
  }

  if (
    items.length === 0 &&
    !compacting &&
    !rows.some((row) => row.kind === "progress")
  ) {
    return (
      <div className="empty-conversation">
        <span className="empty-conversation__mark">
          <img src={gajaeIconUrl} alt="" />
        </span>
        <h2>{t("Gajae에게 어떤 작업을 맡길까요?")}</h2>
        {loadingPage && <p role="status">{t("최근 대화 불러오는 중…")}</p>}
        {pageLoadError && (
          <p role="alert">
            {pageLoadError}{" "}
            {onRetryPage && (
              <button type="button" className="button-secondary" onClick={onRetryPage}>
                {t("다시 불러오기")}
              </button>
            )}
          </p>
        )}
        {emptyStateMeta && (
          <div className="empty-conversation__meta">
            <dl>
              <div>
                <dt>workspace</dt>
                <dd title={emptyStateMeta.workspace}>
                  {directoryName(emptyStateMeta.workspace)}
                </dd>
              </div>
              <div>
                <dt>{t("모델")}</dt>
                <dd>{emptyStateMeta.modelDisplay ?? t("확인 중…")}</dd>
              </div>
            </dl>
            {emptyStateMeta.recentWorkspaces.length > 1 && (
              <div className="empty-conversation__workspaces">
                {emptyStateMeta.recentWorkspaces
                  .filter((workspace) => workspace !== emptyStateMeta.workspace)
                  .slice(0, 4)
                  .map((workspace) => (
                    <button
                      type="button"
                      key={workspace}
                      title={workspace}
                      onClick={() => emptyStateMeta.onWorkspaceChange?.(workspace)}
                    >
                      <FolderGit2 size={12} />
                      {directoryName(workspace)}
                    </button>
                  ))}
              </div>
            )}
            <ul className="empty-conversation__hints">
              <li>
                <kbd>⌘K</kbd>
                <span>{t("세션/메시지 전체 검색")}</span>
              </li>
              <li>
                <kbd>⌘F</kbd>
                <span>{t("이 대화에서 찾기")}</span>
              </li>
              <li>
                <kbd>/</kbd>
                <span>{t("명령어 (예: /compact, /resume)")}</span>
              </li>
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flex: 1, flexDirection: "column", minHeight: 0 }}>
      {loadingPage && items.length > 0 && (
        <div role="status" style={{ flex: "none", padding: "4px 12px", textAlign: "center" }}>
          {t("대화 페이지 불러오는 중…")}
        </div>
      )}
      {pageLoadError && items.length > 0 && (
        <div role="alert" style={{ flex: "none", padding: "4px 12px", textAlign: "center" }}>
          <span>{pageLoadError}</span>{" "}
          {onRetryPage && (
            <button type="button" className="button-secondary" onClick={onRetryPage}>
              {t("다시 불러오기")}
            </button>
          )}
        </div>
      )}
      {hasMoreBefore && atHistoryStart && !following && (
        <div className="transcript-load-earlier" style={{ flex: "none", padding: "6px 12px", textAlign: "center" }}>
          <button
            type="button"
            className="button-secondary"
            disabled={loadingEarlier}
            onClick={loadEarlier}
          >
            {loadingEarlier ? t("이전 대화 불러오는 중…") : loadEarlierError ? t("이전 대화 다시 불러오기") : t("이전 대화 불러오기")}
          </button>
          {loadEarlierError && <span role="alert" style={{ marginLeft: 8 }}>{loadEarlierError}</span>}
        </div>
      )}
      <div
        className="transcript"
        aria-live="polite"
        ref={transcriptRef}
        onScroll={() => {
          updateScrollFollowing();
          const scroller = transcriptRef.current;
          setAtHistoryStart(Boolean(scroller && scroller.scrollTop <= 24));
          if (scroller && gestureLandingRef.current && !followingRef.current && scroller.scrollTop <= 24 && hasMoreBefore && !loadingEarlier && !loadEarlierError)
            loadEarlier();
        }}
      // Input direction carries intent: upward means "reading older content", downward means
      // "moving toward the newest content". Neither direction is a hand-back -- arriving at
      // the newest content is, and so is asking for it outright. The resulting position
      // cannot stand in for this: it is indistinguishable from the measurement slack that
      // unmounted rows need.
      onWheel={(event) => {
        // Real input takes the view back from a resize restoration in flight.
        cancelResizeRestore();
        noteGesture(event.deltaY);
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
        // A finger dragged down (positive clientY) reveals older content, which is the wheel's
        // negative delta: the same sign the gesture rule reads.
        noteGesture(previousY - currentY);
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
            const block = rows[virtualRow.index];
            if (!block) return null;
            return (
              <div
                className="transcript-slot"
                data-index={virtualRow.index}
                data-last={virtualRow.index === rows.length - 1 ? "true" : undefined}
                data-turn-start={turnStarts.has(block.id) ? "true" : undefined}
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {block.kind === "progress" ? (
                  <GajaeProgressRow
                    kind={block.work.kind}
                    label={block.work.label}
                    approval={block.approval}
                    onResolve={onResolveTool}
                    onRetry={onRetryLastRequest ? retryProgress : undefined}
                  />
                ) : block.kind === "item" ? (
                  <div className="transcript-entry" id={`transcript-${encodeURIComponent(block.item.id)}`}>
                    <TranscriptItemView item={block.item} thoughtsExpanded={effectiveThoughtsExpanded} onToggleThoughtsExpanded={onToggleThoughtsExpanded} onResolveTool={onResolveTool} onAnswerQuestion={onAnswerQuestion} onReadArtifact={onReadArtifact} autoDenyHint={autoDenyHint} onRetryLastRequest={onRetryLastRequest} onRevealInspector={onRevealInspector} />
                  </div>
                ) : block.kind === "tools" ? (
                  <ToolRunBlockView items={block.items} toolViewMode={toolViewMode} thoughtsExpanded={effectiveThoughtsExpanded} onToggleThoughtsExpanded={onToggleThoughtsExpanded} onResolveTool={onResolveTool} onReadArtifact={onReadArtifact} autoDenyHint={autoDenyHint} onRevealInspector={onRevealInspector} />
                ) : (
                  <MessageDeliveryRow
                    attempt={block.attempt}
                    onRetry={onRetryDelivery}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!following && (
        <button
          className="scroll-to-latest"
          type="button"
          onClick={() => {
            onReturnToLatest?.();
            scrollToLatest();
          }}
        >
          {t("최신 내용으로")} </button>
      )}
      </div>
    </div>
  );
}



/**
 * A tool-run block, collapsed to a one-line summary in `basic` view mode.
 *
 * A run containing a failure or a pending approval starts expanded so it is not
 * missed. The user can still collapse it after reading the failure; the summary
 * keeps the failure/approval count visible so the choice does not hide it. A new
 * failure reopens the run.
 */
function ToolRunBlockView({
  items,
  toolViewMode,
  thoughtsExpanded,
  onToggleThoughtsExpanded,
  onResolveTool,
  onReadArtifact,
  autoDenyHint,
  onRevealInspector,
}: {
  items: Extract<TranscriptItem, { kind: "tool" }>[];
  toolViewMode: "basic" | "reasoning" | "detailed";
  thoughtsExpanded: boolean;
  onToggleThoughtsExpanded?: () => void;
  onResolveTool: TranscriptProps["onResolveTool"];
  onReadArtifact: TranscriptProps["onReadArtifact"];
  autoDenyHint?: TranscriptProps["autoDenyHint"];
  onRevealInspector?: TranscriptProps["onRevealInspector"];
}) {
  const summary = useMemo(() => summarizeToolRun(items), [items]);
  const needsAttention = !summary.allCompleted;
  const [manual, setManual] = useState<ToolRunManualState>("auto");
  // A failure that arrives while the run is collapsed must not stay hidden.
  const previousAttention = useRef(needsAttention);
  useEffect(() => {
    if (needsAttention && !previousAttention.current) setManual("auto");
    previousAttention.current = needsAttention;
  }, [needsAttention]);
  const collapsed = toolRunCollapsed(toolViewMode, needsAttention, manual);
  if (!collapsed) {
    return (
      <div className="transcript-entry tool-run">
        {toolViewMode === "basic" && (
          <button
            type="button"
            className="tool-run-collapse"
            onClick={() => setManual("collapsed")}
          >
            {t("접기")} </button>
        )}
        {items.map((tool) => (
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
              autoDenyHint={autoDenyHint}
              onRevealInspector={onRevealInspector}
            />
          </div>
        ))}
      </div>
    );
  }
  const parts: string[] = [];
  if (summary.commandCount > 0) parts.push(t`명령 ${summary.commandCount}개 실행`);
  if (summary.fileCount > 0)
    parts.push(
      t`파일 ${summary.fileCount}개 수정 (+${summary.added} \u2212${summary.removed})`,
    );
  if (summary.failedCount > 0)
    parts.push(t`실패 ${summary.failedCount}개`);
  if (summary.approvalRequiredCount > 0)
    parts.push(t`승인 대기 ${summary.approvalRequiredCount}개`);
  return (
    <div className="transcript-entry tool-run tool-run--collapsed">
      <button
        type="button"
        className="tool-run-summary"
        onClick={() => setManual("expanded")}
      >
        <TerminalSquare size={14} />
        <span>{parts.join(" \u00b7 ") || t`도구 ${items.length}개 실행`}</span>
      </button>
    </div>
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
        <span>{t("추론")}</span>
        {!item.streaming && (
          <button
            type="button"
            className="thought-toggle"
            onClick={onToggle}
          >
            {expanded ? t("접기") : t("펼치기")}
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
            <MarkdownBody>{item.content}</MarkdownBody>
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
  onAnswerQuestion,
  onReadArtifact,
  autoDenyHint,
  onRetryLastRequest,
  onRevealInspector,
}: {
  item: TranscriptItem;
  thoughtsExpanded?: boolean;
  onToggleThoughtsExpanded?: () => void;
  onResolveTool: TranscriptProps["onResolveTool"];
  onAnswerQuestion?: TranscriptProps["onAnswerQuestion"];
  onReadArtifact: TranscriptProps["onReadArtifact"];
  autoDenyHint?: TranscriptProps["autoDenyHint"];
  onRetryLastRequest?: TranscriptProps["onRetryLastRequest"];
  onRevealInspector?: TranscriptProps["onRevealInspector"];
}) {
  useLanguage();
  if (item.kind === "message") {
    const copyText = copyableMessageText(item.content);
    const attachments = attachmentSummaryText(item.content);
    const skill = item.role === "user" ? parseSkillInvocation(copyText) : undefined;
    return (
      <article className={`message message--${item.role}${skill ? " message--skill" : ""}`}>
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
            className={`message-body ${item.role === "assistant" ? "markdown-body" : ""}`}
          >
            {skill ? (
              <SkillInvocation name={skill.name} args={skill.args} />
            ) : item.content ? (
              item.role === "assistant" ? (
                item.streaming ? (
                  <StreamingMarkdown content={item.content} />
                ) : (
                  <MarkdownBody>{item.content}</MarkdownBody>
                )
              ) : (
                copyText || item.content
              )
            ) : null}
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
    // A run failure is announced this way (id `gjc-error-`, title "GJC run failed"),
    // and is the one notice tone this app can act on: the request that failed is
    // still known (the transcript's own last user message), so retrying it is one
    // click rather than retyping the prompt.
    const isRunFailure = item.id.startsWith("gjc-error-");
    return (
      <article className={`notice-card notice-card--${item.tone}`}>
        <Check size={16} />
        <span>
          <strong>{item.title}</strong>
          <small>{item.content}</small>
        </span>
        {isRunFailure && onRetryLastRequest && (
          <button
            type="button"
            className="notice-card-retry"
            onClick={() => onRetryLastRequest(item.sessionId)}
          >
            {t("다시 시도")} </button>
        )}
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
    if (item.sourceType?.trim() === "skill-prompt") {
      return <SkillPromptCard item={item} />;
    }
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

  if (item.kind === "question") {
    return (
      <QuestionCard
        item={item}
        onAnswer={onAnswerQuestion ?? (() => undefined)}
      />
    );
  }

  if (item.kind === "plan") {
    return (
      <article className="plan-card">
        <header>
          <ListChecks size={15} />
          <strong>{t("계획")}</strong>
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
      autoDenyHint={item.kind === "tool" && item.status === "denied" ? autoDenyHint : undefined}
      onRevealInspector={onRevealInspector}
    />
  );
});


