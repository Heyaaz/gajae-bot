import { useEffect, useRef, useState } from "react";
import { ArrowUp, MessageCircleQuestion, RotateCcw, Trash2, X } from "lucide-react";
import { t, useLanguage } from "../i18n";
import type { SideExchange } from "./side-questions";
import { MarkdownBody } from "./transcript-markdown";

/**
 * `/btw` beside the conversation: side questions about the session that never
 * enter its transcript, so asking one does not interrupt reading the work.
 */
export function SideQuestionPanel({
  exchanges,
  onAsk,
  onRetry,
  onClear,
  onClose,
}: {
  exchanges: readonly SideExchange[];
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
    if (!question || pending) return;
    onAsk(question);
    setDraft("");
  }

  return (
    <aside className="side-panel" aria-label={t("옆 질문")}>
      <header>
        <span>
          <strong>{t("옆 질문")}</strong>
          <small>{t("대화 기록에 남지 않습니다")}</small>
        </span>
        {exchanges.length > 0 && (
          <button
            className="icon-button"
            type="button"
            title={t("옆 질문 지우기")}
            aria-label={t("옆 질문 지우기")}
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
        {exchanges.length === 0 ? (
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
                <p className="side-exchange-pending" role="status">
                  {t("답을 기다리는 중…")}
                </p>
              ) : exchange.status === "failed" ? (
                <div className="side-exchange-failed" role="alert">
                  <span>{exchange.error}</span>
                  <button type="button" onClick={() => onRetry(exchange.id)}>
                    <RotateCcw size={12} aria-hidden="true" />
                    {t("다시 묻기")}
                  </button>
                </div>
              ) : (
                <div className="side-exchange-answer">
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
          placeholder={exchanges.length > 0 ? t("이어서 묻기") : t("무엇이든 물어보세요")}
          aria-label={t("옆 질문 입력")}
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
          disabled={pending || !draft.trim()}
          title={t("묻기")}
          aria-label={t("묻기")}
        >
          <ArrowUp size={15} />
        </button>
      </form>
    </aside>
  );
}
