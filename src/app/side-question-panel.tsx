import { useEffect, useRef, useState } from "react";
import { ArrowUp, MessageCircleQuestion, RotateCcw, Trash2, X } from "lucide-react";
import { t, useLanguage } from "../i18n";
import type { SideExchange } from "./side-questions";
import { formatDuration } from "./format";
import { MarkdownBody } from "./transcript-markdown";

/** GJC gives up on a /btw answer after 120 s; past this the wait is worth explaining. */
const LONG_WAIT_MS = 30_000;

/** The wait for an answer: moving dots so it reads as live, and how long it has been. */
function SidePending({ askedAt }: { askedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const waited = Math.max(0, now - askedAt);
  return (
    <div className="side-exchange-pending" role="status">
      <span className="side-exchange-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{t("답을 생각하는 중")}</span>
      {waited >= 1000 && <span className="side-exchange-elapsed">{formatDuration(waited)}</span>}
      {waited >= LONG_WAIT_MS && (
        <small>{t("답이 길어지고 있습니다. 최대 2분까지 기다립니다.")}</small>
      )}
    </div>
  );
}

/**
 * `/btw` beside the conversation: side questions about the session that never
 * enter its transcript, so asking one does not interrupt reading the work.
 */
export function SideQuestionPanel({
  exchanges,
  unsupported = false,
  onAsk,
  onRetry,
  onClear,
  onClose,
}: {
  exchanges: readonly SideExchange[];
  /** The session's GJC has no `btw.ask`, so nothing can be asked. */
  unsupported?: boolean;
  onAsk: (question: string) => void;
  onRetry: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  useLanguage();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pending = exchanges.some((exchange) => exchange.status === "pending");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const last = exchanges.at(-1);
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [last?.id, last?.status]);

  function submit(): void {
    const question = draft.trim();
    if (!question || pending || unsupported) return;
    onAsk(question);
    setDraft("");
  }

  return (
    <aside className="side-panel" aria-label={t("사이드 채팅")}>
      <header>
        <span>
          <strong>{t("사이드 채팅")}</strong>
          <small>{t("대화 기록에 남지 않습니다")}</small>
        </span>
        {exchanges.length > 0 && (
          <button
            className="icon-button"
            type="button"
            title={t("사이드 채팅 지우기")}
            aria-label={t("사이드 채팅 지우기")}
            onClick={onClear}
          >
            <Trash2 size={15} />
          </button>
        )}
        <button
          className="icon-button"
          type="button"
          title={t("닫기")}
          aria-label={t("닫기")}
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      <div className="side-panel-list" ref={listRef}>
        {unsupported && exchanges.length === 0 ? (
          <div className="side-panel-empty" role="status">
            <MessageCircleQuestion size={22} aria-hidden="true" />
            <p>{t("이 세션의 GJC는 사이드 채팅을 지원하지 않습니다.")}</p>
            <small>{t("사이드 채팅에는 GJC의 btw.ask 기능이 필요합니다. 이 기능이 들어간 GJC로 업데이트하면 쓸 수 있습니다.")}</small>
          </div>
        ) : exchanges.length === 0 ? (
          <div className="side-panel-empty">
            <MessageCircleQuestion size={22} aria-hidden="true" />
            <p>{t("작업을 멈추지 않고 이 세션에 대해 따로 물어볼 수 있습니다.")}</p>
            <small>{t("/btw 질문 · ⌘⇧B")}</small>
          </div>
        ) : (
          exchanges.map((exchange) => (
            <section className="side-exchange" key={exchange.id}>
              <p className="side-exchange-question">{exchange.question}</p>
              {exchange.status === "pending" ? (
                <SidePending askedAt={exchange.askedAt} />
              ) : exchange.status === "failed" ? (
                <div className="side-exchange-failed" role="alert">
                  <span>{exchange.error}</span>
                  <button type="button" onClick={() => onRetry(exchange.id)}>
                    <RotateCcw size={12} aria-hidden="true" />
                    {t("다시 묻기")}
                  </button>
                </div>
              ) : (
                <div className="side-exchange-answer markdown-body">
                  <MarkdownBody>{exchange.answer}</MarkdownBody>
                </div>
              )}
            </section>
          ))
        )}
      </div>
      <form
        className="side-panel-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          rows={2}
          disabled={unsupported}
          placeholder={exchanges.length > 0 ? t("이어서 묻기") : t("무엇이든 물어보세요")}
          aria-label={t("사이드 채팅 입력")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
        />
        <button
          type="submit"
          className="side-panel-send"
          disabled={pending || unsupported || !draft.trim()}
          title={t("묻기")}
          aria-label={t("묻기")}
        >
          <ArrowUp size={15} />
        </button>
      </form>
    </aside>
  );
}
