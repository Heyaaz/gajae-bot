import ReactMarkdown from "react-markdown";
import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import remarkGfm from "remark-gfm";
import type { ArtifactContent, GeneratedFilePreview } from "../../shared/agent-contract";
import type { ToolActivity, TranscriptItem } from "../backend/types";
import { compactToolCommand, compactToolText } from "../composer-utils";
import {
  attachmentSummaryText,
  copyableMessageText,
  groupTranscriptItems,
  isNearTranscriptBottom,
  recentUserRequests,
  transcriptBlockIndexForItem,
} from "../transcript-utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Brain,
  Check,
  ChevronDown,
  Clock3,
  FileSearch,
  GitFork,
  ListChecks,
  Paperclip,
  ShieldCheck,
  Shrink,
  TerminalSquare,
  X,
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { httpUrls, humanRuntimeText, toolDisplayName, toolStatusLabel } from "./format";
import { DiffView, LinkPreviewCard, MessageCopyButton } from "./primitives";

export interface TranscriptProps {
  items: TranscriptItem[];
  compacting?: boolean;
  revealItemId?: string;
  onRevealComplete?: (itemId: string) => void;
  onResolveTool: (toolId: string, optionId: string) => void;
  onReadArtifact?: (artifactId: string) => Promise<ArtifactContent>;
  onPreviewFile?: (path: string) => Promise<GeneratedFilePreview>;
}

export function Transcript({
  items,
  compacting = false,
  revealItemId,
  onRevealComplete,
  onResolveTool,
  onReadArtifact,
  onPreviewFile,
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
  const [following, setFollowing] = useState(true);

  const blocks = useMemo(() => groupTranscriptItems(items), [items]);

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

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    // A width change re-wraps text, so every height measured at the old width is wrong.
    // Without discarding them the cached totals drift and the view drops thousands of
    // pixels away from where it was -- opening the detail panel or resizing the window
    // both do this.
    let lastWidth = transcript.clientWidth;
    let remeasure = 0;
    const observer = new ResizeObserver(() => {
      const element = transcriptRef.current;
      const width = element?.clientWidth ?? lastWidth;
      if (!element || width === lastWidth) return;
      lastWidth = width;
      // A resize is not the user scrolling away, so following must survive it. Discarding
      // the heights below makes the scroll position briefly look far from the bottom, and
      // the scroll events that causes had been switching following off -- which then
      // cancelled the restore and left the view 1284px short at narrow widths.
      selfScrollingRef.current = true;
      virtualizer.measure();
      // Re-measuring is handled by the layout effect above; this only restores the scroll
      // position. It takes several frames: `measure()` drops every height, so rows are
      // re-measured one render at a time and the bottom keeps moving. A single restore
      // landed 1284px short at narrow widths, so it retries until the bottom holds.
      cancelAnimationFrame(remeasure);
      let attempts = 0;
      const restore = (): void => {
        const scroller = transcriptRef.current;
        if (!scroller || !followingRef.current) {
          selfScrollingRef.current = false;
          return;
        }
        selfScrollingRef.current = true;
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
        attempts += 1;
        const settled =
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1;
        if ((settled && attempts > 3) || attempts > 30) {
          selfScrollingRef.current = false;
          return;
        }
        remeasure = requestAnimationFrame(restore);
      };
      remeasure = requestAnimationFrame(restore);
    });
    observer.observe(transcript);
    return () => {
      cancelAnimationFrame(remeasure);
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
    // its element exists to highlight.
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
    // Wider than the default 48px, because rows above are unmounted and the scroll height
    // is an estimate: a drag to the end can still measure a few hundred pixels short, and
    // reading that as "scrolled away" leaves the view stalled with a blank band under the
    // newest message.
    //
    // But not a whole viewport either. That much slack also swallowed a small deliberate
    // scroll up -- park 400px above the bottom and the view slid back down. A third of a
    // viewport covers the estimation error while leaving a nudge upward alone.
    const nearBottom = isNearTranscriptBottom(
      transcript.scrollHeight,
      transcript.scrollTop,
      transcript.clientHeight,
      Math.round(transcript.clientHeight / 3),
    );
    followingRef.current = nearBottom;
    setFollowing(nearBottom);

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
                      onResolveTool={onResolveTool}
                      onReadArtifact={onReadArtifact}
                      onPreviewFile={onPreviewFile}
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
                          onResolveTool={onResolveTool}
                          onReadArtifact={onReadArtifact}
                          onPreviewFile={onPreviewFile}
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

export function SystemNoticeCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "system" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = item.content.split("\n").slice(0, 4).join("\n");
  const truncated = item.content !== preview;
  return (
    <article className="system-card">
      <header>
        <TerminalSquare size={15} />
        <strong>{item.title}</strong>
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

export function ThoughtCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "thought" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const open = item.streaming || expanded;
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
            onClick={() => setExpanded((value) => !value)}
          >
            {open ? "접기" : "펼치기"}
          </button>
        )}
      </header>
      {open && (
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
  onResolveTool,
  onReadArtifact,
  onPreviewFile,
}: {
  item: TranscriptItem;
  onResolveTool: TranscriptProps["onResolveTool"];
  onReadArtifact: TranscriptProps["onReadArtifact"];
  onPreviewFile: TranscriptProps["onPreviewFile"];
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
    return <SystemNoticeCard item={item} />;
  }

  if (item.kind === "thought") {
    return <ThoughtCard item={item} />;
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
      onPreviewFile={onPreviewFile}
    />
  );
});

export interface ToolCardProps {
  tool: ToolActivity;
  onResolve: (toolId: string, optionId: string) => void;
  onReadArtifact?: (artifactId: string) => Promise<ArtifactContent>;
  onPreviewFile?: (path: string) => Promise<GeneratedFilePreview>;
}

export function ToolCard({
  tool,
  onResolve,
  onReadArtifact,
  onPreviewFile,
}: ToolCardProps) {
  const approvalRequired = tool.status === "approval-required";
  const [expanded, setExpanded] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactContent | null>(null);
  const [artifactError, setArtifactError] = useState("");
  const [preview, setPreview] = useState<GeneratedFilePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
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
        {tool.targetPath && /^(write|edit)$/iu.test(tool.name) && (
          <button
            className="generated-preview-button"
            type="button"
            disabled={previewBusy}
            onClick={() => {
              if (!onPreviewFile) return;
              setPreviewBusy(true);
              void onPreviewFile(tool.targetPath!)
                .then(setPreview)
                .catch((error) =>
                  setArtifactError(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
                .finally(() => setPreviewBusy(false));
            }}
          >
            <FileSearch size={12} />
            {previewBusy ? "미리보기 여는 중…" : "결과물 미리보기"}
          </button>
        )}
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
      {preview && (
        <GeneratedPreviewModal
          preview={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

export function GeneratedPreviewModal({
  preview,
  onClose,
}: {
  preview: GeneratedFilePreview;
  onClose: () => void;
}) {
  return (
    <div className="preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="generated-preview"
        role="dialog"
        aria-label={`${preview.name} 미리보기`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span>
            <strong>{preview.name}</strong>
            <small>
              {preview.path} · {(preview.size / 1024).toFixed(1)} KB
            </small>
          </span>
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="generated-preview-body">
          {preview.kind === "image" && preview.dataUrl && (
            <img src={preview.dataUrl} alt={preview.name} />
          )}
          {preview.kind === "pdf" && preview.dataUrl && (
            <iframe src={preview.dataUrl} title={preview.name} />
          )}
          {preview.kind === "markdown" && preview.content !== undefined && (
            <article className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {preview.content}
              </ReactMarkdown>
            </article>
          )}
          {preview.kind === "html" && (
            <iframe sandbox="" srcDoc={preview.content} title={preview.name} />
          )}
          {preview.kind === "text" && <pre>{preview.content}</pre>}
          {preview.kind === "unsupported" && (
            <p>
              이 파일 형식은 앱에서 미리 볼 수 없습니다. 경로는 GJC에서 계속
              사용할 수 있습니다.
            </p>
          )}
        </div>
      </section>
    </div>
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
