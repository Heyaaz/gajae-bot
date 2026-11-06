import sprite80 from "../assets/gajae-progress-sprite@80.webp";
import sprite160 from "../assets/gajae-progress-sprite@160.webp";
import {
  GAJAE_EMOTICONS,
  GAJAE_PROGRESS_ROW_HEIGHT,
  QUIET_AFTER_MS,
  ROTATING_WORK_LABELS,
  elapsedTurnMs,
  gajaeEmoticonFor,
  gajaeEmoticonFrame,
  type GajaeEmoticon,
  type TurnActivityKind,
  type TurnApproval,
  type TurnClock,
} from "../transcript-utils";
import { memo, useContext, useEffect, useRef, useState } from "react";
import { t, useLanguage } from "../i18n";
import { LoginHintContext } from "./login-hint";
import { formatDuration } from "./format";
import type { SessionRetry } from "../backend/types";


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

/**
 * How long the running turn has worked, when it last produced anything once it has
 * been quiet for a while, and whether a message sent into it is still unread. The
 * one-second tick re-renders only this text.
 */
function WorkingMeta({
  clock,
  activityAt,
  queuedMessage,
}: {
  clock: TurnClock;
  activityAt: number;
  queuedMessage: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const idle = now - activityAt;
  const parts = [formatDuration(elapsedTurnMs(clock, now))];
  if (idle >= QUIET_AFTER_MS) parts.push(t`마지막 활동 ${formatDuration(idle)} 전`);
  if (queuedMessage) parts.push(t("보낸 메시지는 지금 단계가 끝나면 읽힙니다"));
  return <span className="gajae-progress-meta">{parts.join(" · ")}</span>;
}

/**
 * GJC's wait before it sends a failed model call again: which attempt, how long
 * until it fires, and why the last one failed. Either button ends the wait.
 */
function RetryMeta({
  retry,
  onControl,
}: {
  retry: SessionRetry;
  onControl?: (action: "now" | "abort") => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [sent, setSent] = useState<string>();
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const key = `${retry.attempt}:${retry.retryAt}`;
  const remaining = retry.retryAt - now;
  const parts = [
    retry.maxAttempts === undefined
      ? t`재시도 ${retry.attempt}회째`
      : t`재시도 ${retry.attempt}/${retry.maxAttempts}`,
    remaining >= 1000 ? t`${formatDuration(remaining)} 후` : t("곧 다시 보냄"),
  ];
  const error = retry.error?.split("\n", 1)[0];
  const control = (action: "now" | "abort") => {
    setSent(key);
    onControl?.(action);
  };
  return (
    <>
      <span className="gajae-progress-meta" title={retry.error}>
        {parts.join(" · ")}
        {error && <span className="gajae-progress-error"> · {error}</span>}
      </span>
      {onControl && (
        <span className="gajae-progress-actions">
          <button
            type="button"
            className="gajae-progress-button"
            disabled={sent === key}
            onClick={() => control("abort")}
          >
            {t("재시도 취소")}
          </button>
          <button
            type="button"
            className="gajae-progress-button is-allow"
            disabled={sent === key}
            onClick={() => control("now")}
          >
            {t("지금 재시도")}
          </button>
        </span>
      )}
    </>
  );
}

export interface GajaeProgressRowProps {
  kind: TurnActivityKind;
  label?: string;
  /** The turn's clock. A running row shows its elapsed time. */
  clock?: TurnClock;
  /** When the turn last produced anything. */
  activityAt?: number;
  queuedMessage?: boolean;
  /** GJC is waiting to retry a failed model call. Replaces the elapsed time. */
  retry?: SessionRetry;
  onControlRetry?: (action: "now" | "abort") => void;
  approval?: TurnApproval;
  onResolve?: (toolId: string, optionId: string) => void;
  onRetry?: () => void;
}

/**
 * The gajae at the end of the current turn.
 *
 * Kind and label are the only inputs that come from the transcript. The rotating
 * phrase updates inside this row, so a label swap does not re-render the conversation.
 */
export const GajaeProgressRow = memo(function GajaeProgressRow({
  kind,
  label,
  clock,
  activityAt,
  queuedMessage = false,
  retry,
  onControlRetry,
  approval,
  onResolve,
  onRetry,
}: GajaeProgressRowProps) {
  useLanguage();
  const { needsSignIn, openLogin } = useContext(LoginHintContext);
  // A turn that fails on a Mac with no signed-in provider failed for that reason;
  // GJC's own error says nothing the user can act on.
  const loginCause = kind === "error" && needsSignIn && openLogin !== undefined;
  const rootRef = useRef<HTMLDivElement>(null);
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
  const shownLabel = loginCause
    ? t("로그인한 AI가 없어 실행하지 못했어요")
    : rotates
    ? t(ROTATING_WORK_LABELS[labelIndex] ?? ROTATING_WORK_LABELS[0])
    : (label ?? (kind === "done" ? t("완료") : ""));

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
    if (!root) return;
    let rotateTimer = 0;
    let onScreen = true;

    const stopTimers = (): void => {
      window.clearInterval(rotateTimer);
      rotateTimer = 0;
    };
    const sync = (): void => {
      const tabHidden = typeof document !== "undefined" && document.hidden;
      const paused = tabHidden || !onScreen;
      root.classList.toggle("is-paused", paused);
      stopTimers();
      if (paused || !rotates) return;
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
  }, [rotates]);

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
        {retry && kind === "thinking" ? (
          <RetryMeta retry={retry} onControl={onControlRetry} />
        ) : (
          clock && activityAt !== undefined && (kind === "thinking" || kind === "tool") && (
            <WorkingMeta clock={clock} activityAt={activityAt} queuedMessage={queuedMessage} />
          )
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
                {t("거절")} </button>
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
                {t("허용")} </button>
            )}
          </span>
        )}
        {loginCause && (
          <button type="button" className="gajae-progress-button is-allow" onClick={openLogin}>
            {t("AI 로그인")}
          </button>
        )}
        {kind === "error" && onRetry && (
          <button type="button" className="gajae-progress-button" onClick={onRetry}>
            {t("다시 시도")} </button>
        )}
      </div>
      <div
        className="gajae-progress-summary"
        aria-hidden={summary ? undefined : true}
        aria-live={summary ? "polite" : undefined}
      >
        <GajaeSprite emoticon="celebrate" size={20} ready={spriteReady} />
        <span>{t("완료")}</span>
      </div>
    </div>
  );
});
