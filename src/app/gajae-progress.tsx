import sprite80 from "../assets/gajae-progress-sprite@80.webp";
import sprite160 from "../assets/gajae-progress-sprite@160.webp";
import {
  GAJAE_EMOTICONS,
  GAJAE_PROGRESS_ROW_HEIGHT,
  ROTATING_WORK_LABELS,
  elapsedTurnMs,
  formatElapsedClock,
  formatWorkedSummary,
  gajaeEmoticonFor,
  gajaeEmoticonFrame,
  type GajaeEmoticon,
  type TurnActivityKind,
  type TurnApproval,
} from "../transcript-utils";
import { memo, useEffect, useRef, useState } from "react";

const SHEET_80_WIDTH = 80 * GAJAE_EMOTICONS.length;
const SHEET_160_WIDTH = 160 * GAJAE_EMOTICONS.length;
const LABEL_ROTATE_MS = 2400;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function decodeSprite(src: string): Promise<void> {
  if (typeof Image === "undefined") return Promise.resolve();
  const image = new Image();
  image.src = src;
  const pending =
    typeof image.decode === "function"
      ? image.decode()
      : new Promise<void>((resolve) => {
          image.onload = () => resolve();
          image.onerror = () => resolve();
        });
  return pending.then(
    () => undefined,
    () => undefined,
  );
}

// One decode for the whole sheet, started at import so the first row does not
// paint an undecoded frame. Both densities are warmed; the browser picks one.
const spritesDecoded: Promise<void> =
  typeof window === "undefined"
    ? Promise.resolve()
    : Promise.all([decodeSprite(sprite80), decodeSprite(sprite160)]).then(
        () => undefined,
      );

function GajaeSprite({
  emoticon,
  size,
  ready,
}: {
  emoticon: GajaeEmoticon;
  size: 40 | 20;
  ready: boolean;
}) {
  const frame = gajaeEmoticonFrame(emoticon);
  return (
    <span className={`gajae-sprite gajae-sprite--${size}`} aria-hidden="true">
      {ready ? (
        <img
          src={sprite160}
          srcSet={`${sprite80} ${SHEET_80_WIDTH}w, ${sprite160} ${SHEET_160_WIDTH}w`}
          sizes={`${size * GAJAE_EMOTICONS.length}px`}
          alt=""
          draggable={false}
          style={{ transform: `translate3d(${-frame * size}px, 0, 0)` }}
        />
      ) : null}
    </span>
  );
}

export interface GajaeProgressRowProps {
  kind: TurnActivityKind;
  label?: string;
  ticking: boolean;
  startedAt: number;
  pausedMs: number;
  heldAt?: number;
  approval?: TurnApproval;
  onResolve?: (toolId: string, optionId: string) => void;
  onRetry?: () => void;
}

function clockText(
  clock: { zeroAt: number; pausedMs: number; heldAt?: number },
  ticking: boolean,
  pausedMark: boolean,
): string {
  const now = ticking ? Date.now() : (clock.heldAt ?? Date.now());
  const elapsed = formatElapsedClock(elapsedTurnMs(clock, now));
  return pausedMark ? `Ⅱ ${elapsed}` : elapsed;
}

/**
 * The gajae at the end of the current turn.
 *
 * Kind and label are the only inputs that come from the transcript. The clock
 * text and the rotating phrase update inside this row, writing the time node
 * directly, so a ticking second does not re-render the conversation.
 */
export const GajaeProgressRow = memo(function GajaeProgressRow({
  kind,
  label,
  ticking,
  startedAt,
  pausedMs,
  heldAt,
  approval,
  onResolve,
  onRetry,
}: GajaeProgressRowProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [spriteReady, setSpriteReady] = useState(false);
  const [labelIndex, setLabelIndex] = useState(0);
  const [summary, setSummary] = useState(
    () => kind === "done" && prefersReducedMotion(),
  );
  const [summaryKind, setSummaryKind] = useState(kind);
  if (kind !== summaryKind) {
    setSummaryKind(kind);
    setSummary(kind === "done" && prefersReducedMotion());
  }
  const rotates = (kind === "thinking" || kind === "tool") && label === undefined;
  const emoticon = gajaeEmoticonFor(kind);
  const shimmer = kind === "thinking" || kind === "tool";
  const motion =
    kind === "thinking" ||
    kind === "tool" ||
    kind === "approval" ||
    (kind === "done" && !summary);
  const pausedMark = kind === "waiting" || kind === "approval";
  const clock = { zeroAt: startedAt, pausedMs, heldAt };
  const shownLabel = rotates
    ? ROTATING_WORK_LABELS[labelIndex] ?? ROTATING_WORK_LABELS[0]
    : (label ?? (kind === "done" ? "완료" : ""));
  const summaryText = `${formatWorkedSummary(elapsedTurnMs(clock, heldAt ?? startedAt))} ▸`;

  useEffect(() => {
    let live = true;
    void spritesDecoded.then(() => {
      if (live) setSpriteReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (kind !== "done" || summary || prefersReducedMotion()) return;
    const timer = window.setTimeout(() => setSummary(true), 1000);
    return () => window.clearTimeout(timer);
  }, [kind, summary]);

  useEffect(() => {
    const root = rootRef.current;
    const timeNode = timeRef.current;
    if (!root || !timeNode) return;
    let timer = 0;
    let rotateTimer = 0;
    let onScreen = true;

    const paintTime = (): void => {
      timeNode.textContent = clockText(
        { zeroAt: startedAt, pausedMs, heldAt },
        ticking,
        pausedMark,
      );
    };
    const stopTimers = (): void => {
      window.clearInterval(timer);
      window.clearInterval(rotateTimer);
      timer = 0;
      rotateTimer = 0;
    };
    const sync = (): void => {
      const tabHidden = typeof document !== "undefined" && document.hidden;
      const paused = tabHidden || !onScreen;
      root.classList.toggle("is-paused", paused);
      stopTimers();
      paintTime();
      if (paused) return;
      if (ticking) timer = window.setInterval(paintTime, 1000);
      if (rotates)
        rotateTimer = window.setInterval(() => {
          setLabelIndex((index) => (index + 1) % ROTATING_WORK_LABELS.length);
        }, LABEL_ROTATE_MS);
    };

    const onVisibility = (): void => sync();
    document.addEventListener("visibilitychange", onVisibility);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            onScreen = entries[0]?.isIntersecting ?? true;
            sync();
          });
    observer?.observe(root);
    sync();
    return () => {
      stopTimers();
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    };
  }, [heldAt, pausedMark, pausedMs, rotates, startedAt, ticking]);

  return (
    <div
      ref={rootRef}
      className={[
        "gajae-progress",
        `gajae-progress--${kind}`,
        motion ? "is-motion" : "",
        summary ? "is-summary" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ height: GAJAE_PROGRESS_ROW_HEIGHT }}
      data-kind={kind}
      data-emoticon={emoticon}
    >
      <div className="gajae-progress-live" aria-hidden={summary || undefined}>
        <span className={`gajae-avatar gajae-avatar--${emoticon}`}>
          <GajaeSprite emoticon={emoticon} size={40} ready={spriteReady} />
          {kind === "waiting" && (
            <>
              <span className="gajae-z gajae-z-1">z</span>
              <span className="gajae-z gajae-z-2">z</span>
              <span className="gajae-z gajae-z-3">Z</span>
            </>
          )}
        </span>
        <span
          className={`gajae-progress-label${shimmer ? " is-shimmer" : ""}`}
          aria-live="polite"
        >
          {shownLabel}
        </span>
        <span ref={timeRef} className="gajae-progress-time" aria-hidden="true">
          {clockText(clock, ticking, pausedMark)}
        </span>
        {(kind === "thinking" || kind === "tool") && (
          <span className="gajae-progress-stop">
            <kbd>Esc</kbd> 중단
          </span>
        )}
        {kind === "approval" && approval && (approval.deny || approval.allow) && (
          <span className="gajae-progress-actions">
            {approval.deny && (
              <button
                type="button"
                className="gajae-progress-button"
                onClick={() => {
                  const deny = approval.deny;
                  if (deny) onResolve?.(approval.toolId, deny.optionId);
                }}
              >
                거절
              </button>
            )}
            {approval.allow && (
              <button
                type="button"
                className="gajae-progress-button is-allow"
                onClick={() => {
                  const allow = approval.allow;
                  if (allow) onResolve?.(approval.toolId, allow.optionId);
                }}
              >
                허용
              </button>
            )}
          </span>
        )}
        {kind === "error" && onRetry && (
          <button type="button" className="gajae-progress-button" onClick={onRetry}>
            다시 시도
          </button>
        )}
      </div>
      <div
        className="gajae-progress-summary"
        aria-hidden={summary ? undefined : true}
        aria-live={summary ? "polite" : undefined}
      >
        <GajaeSprite emoticon="celebrate" size={20} ready={spriteReady} />
        <span>{summaryText}</span>
      </div>
    </div>
  );
});
