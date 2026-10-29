import type { TranscriptRequestSummary } from "../../shared/agent-contract";
import type { TranscriptItem } from "../backend/types";
import { recentUserRequests, searchTranscriptItems } from "../transcript-utils";
import {
  Clock3,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toolDisplayName } from "./format";
import { t } from "../i18n";

export function RecentRequestStrip({
  items,
  requestSummaries,
  onReveal,
}: {
  items: TranscriptItem[];
  requestSummaries?: TranscriptRequestSummary[];
  onReveal: (id: string) => void;
}) {
  const [timelineOpen, setTimelineOpen] = useState(false);
  const requests = useMemo(() => recentUserRequests(items), [items]);
  // The full timeline covers every user prompt the chips cannot: it is only worth
  // offering once there is a prompt the chip strip left out.
  const timeline = useMemo(
    () => requestSummaries ?? recentUserRequests(items, Number.POSITIVE_INFINITY),
    [items, requestSummaries],
  );
  if (requests.length === 0) return null;
  return (
    <section className="recent-requests" aria-label={t("최근 요청")}>
      <header>
        <Clock3 size={11} />
        <strong>{t("최근 요청")}</strong>
        {timeline.length > requests.length && (
          <button
            type="button"
            className="recent-requests-timeline-toggle"
            onClick={() => setTimelineOpen((open) => !open)}
          >
            {t("타임라인 (")}{timeline.length})
          </button>
        )}
      </header>
      <div className="recent-request-chips">
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
      {timelineOpen && (
        <div className="prompt-timeline" role="dialog" aria-label={t("전체 요청 타임라인")} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setTimelineOpen(false); } }}>
          <header>
            <strong>{t("요청 타임라인")}</strong>
            <button
              type="button"
              aria-label={t("닫기")}
              onClick={() => setTimelineOpen(false)}
            >
              <X size={13} />
            </button>
          </header>
          <ol>
            {timeline.map((request, index) => (
              <li key={request.id}>
                <button
                  type="button"
                  title={request.text}
                  onClick={() => {
                    onReveal(request.id);
                    setTimelineOpen(false);
                  }}
                >
                  <span>{index + 1}</span>
                  <strong>{request.text}</strong>
                  <time>{request.createdAt}</time>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

export interface ApprovalBannerProps {
  pending: Extract<TranscriptItem, { kind: "tool" }>[];
  /** Which pending approval the ⌘↵/⌘⌫ shortcuts and "다음" button target. */
  focusedId?: string;
  onReveal: (toolId: string) => void;
  onFocusChange: (toolId: string) => void;
}

/**
 * A sticky banner above the composer naming how many tool calls are waiting on an
 * approval decision, so a reader who scrolled up (or who is deep in a long tool
 * run) does not lose track of one.
 *
 * It surfaces only the *location*: approving or rejecting still happens on the card
 * itself (via its own permissionOptions), once the banner or ⌘↵/⌘⌫ has brought it
 * on screen. A richer approval card that can decide from the banner directly needs
 * the reverse GJC approval channel this app does not have (see README, Permission
 * handling) and is out of scope here.
 */
export function ApprovalBanner({
  pending,
  focusedId,
  onReveal,
  onFocusChange,
}: ApprovalBannerProps) {
  if (pending.length === 0) return null;
  const focused = pending.find((tool) => tool.id === focusedId) ?? pending[0]!;
  return (
    <div className="approval-banner" role="status">
      <ShieldCheck size={14} />
      <span>
        {t("승인 대기")} {pending.length}{t("건 ·")} {toolDisplayName(focused.name)}
      </span>
      <button
        type="button"
        className="approval-banner-jump"
        onClick={() => onReveal(focused.id)}
      >
        {t("해당 위치로 이동")} </button>
      {pending.length > 1 && (
        <button
          type="button"
          className="approval-banner-next"
          onClick={() => {
            const index = pending.findIndex((tool) => tool.id === focused.id);
            const next = pending[(index + 1) % pending.length]!;
            onFocusChange(next.id);
            onReveal(next.id);
          }}
        >
          {t("다음 대기 (")}{pending.length})
        </button>
      )}
    </div>
  );
}

export interface ConversationFindBarProps {
  items: TranscriptItem[];
  onClose: () => void;
  onReveal: (itemId: string) => void;
}

/**
 * ⌘F: find within the open conversation, distinct from ⌘K's cross-session global
 * search. Matches run entirely over the items already held in memory
 * (`searchTranscriptItems`), so a hit outside the mounted virtualized window is
 * still found and reached through the existing reveal/highlight path -- the same
 * one the global search dialog and the approval banner's jump button use.
 */
export function ConversationFindBar({
  items,
  onClose,
  onReveal,
}: ConversationFindBarProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => searchTranscriptItems(items, query), [items, query]);
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;
  const boundedIndex = matches.length ? Math.min(index, matches.length - 1) : 0;
  const matchedId = matches[boundedIndex];

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (matchedId) revealRef.current(matchedId);
  }, [matchedId]);

  function step(delta: number): void {
    if (matches.length === 0) return;
    setIndex((current) => (Math.min(current, matches.length - 1) + delta + matches.length) % matches.length);
  }

  return (
    <div className="conversation-find" role="search">
      <Search size={14} />
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={t("이 대화에서 찾기")}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="conversation-find-count">
        {query.trim() ? `${matches.length === 0 ? 0 : boundedIndex + 1}/${matches.length}` : ""}
      </span>
      <button
        type="button"
        aria-label={t("이전 결과")}
        disabled={matches.length === 0}
        onClick={() => step(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label={t("다음 결과")}
        disabled={matches.length === 0}
        onClick={() => step(1)}
      >
        ↓
      </button>
      <button type="button" aria-label={t("닫기")} onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}
