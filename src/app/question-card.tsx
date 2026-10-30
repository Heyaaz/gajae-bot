import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, CircleHelp, ClipboardCheck } from "lucide-react";
import type { QuestionActivity, QuestionSubmission } from "../backend/types";
import { t, useLanguage } from "../i18n";

export interface QuestionCardProps {
  item: QuestionActivity;
  onAnswer: (
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ) => void;
  /** The copy pinned above the composer takes focus. The transcript copy does not. */
  autoFocus?: boolean;
  /**
   * The transcript copy of an open question. The pinned copy above the composer
   * is the one to answer, so this one only marks where the question was asked.
   */
  answeredAbove?: boolean;
}

function questionIdempotencyKey(gateId: string): string {
  const nonce =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `gajae-gate-${gateId.replace(/[^A-Za-z0-9._:-]/gu, "")}-${nonce}`.slice(0, 200);
}

function statusLabel(status: QuestionActivity["status"]): string {
  if (status === "answered") return t("답변함");
  if (status === "cancelled") return t("취소됨");
  if (status === "timeout") return t("시간 초과");
  if (status === "rejected") return t("다시 답해 주세요");
  return t("답변을 기다리고 있어요");
}

/**
 * One ask gate: a single line, choice buttons, and a free-text other field.
 *
 * Number keys 1–9 select, Enter submits, and Escape clears the free-text
 * field. A settled card keeps only the result.
 */
export function QuestionCard({
  item,
  onAnswer,
  autoFocus = false,
  answeredAbove = false,
}: QuestionCardProps) {
  useLanguage();
  const open = item.answerable && (item.status === "pending" || item.status === "rejected");
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const labelId = useId();
  const firstOption = useRef<HTMLButtonElement>(null);
  const otherField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSubmitting(false);
  }, [item.status, item.error, item.id]);

  useEffect(() => {
    if (!autoFocus || !open) return;
    if (firstOption.current) firstOption.current.focus();
    else otherField.current?.focus();
  }, [autoFocus, open, item.id]);

  const kindClass = item.approval ? " question-card--approval" : "";
  const head = (hint?: string) => (
    <header className="question-card-head">
      {item.approval ? <ClipboardCheck size={13} aria-hidden /> : <CircleHelp size={13} aria-hidden />}
      {item.approval ? (
        <p className="question-card-kind">{t("계획 승인")}</p>
      ) : (
        <span>{t("질문")}</span>
      )}
      {hint && <small>{hint}</small>}
    </header>
  );

  const elsewhere = open && answeredAbove;
  if (!open || elsewhere) {
    const answered = item.status === "answered";
    return (
      <article
        className={`question-card question-card--${elsewhere ? "elsewhere" : item.status} question-card--settled${kindClass}`}
        data-question-id={item.id}
        data-question-status={item.status}
        aria-live="polite"
      >
        {head()}
        <p className="question-card-line">{item.question}</p>
        <p className="question-card-result">
          {answered && <Check size={12} aria-hidden />}
          {elsewhere
            ? t("입력창 위에서 답해 주세요")
            : item.answerSummary || statusLabel(item.status)}
        </p>
      </article>
    );
  }

  const submit = (nextSelected: string[], nextCustom: string): void => {
    if (submitting) return;
    const customText = nextCustom.trim();
    const chosen = customText ? [] : nextSelected;
    if (chosen.length === 0 && !customText) return;
    setSubmitting(true);
    onAnswer(
      item.id,
      {
        selected: chosen,
        ...(customText ? { custom: customText } : {}),
      },
      questionIdempotencyKey(item.id),
    );
  };

  const toggle = (label: string): void => {
    setCustom("");
    setSelected((current) => {
      if (!item.multi) return current.length === 1 && current[0] === label ? current : [label];
      return current.includes(label)
        ? current.filter((entry) => entry !== label)
        : [...current, label];
    });
    if (!item.multi) submit([label], "");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const typing = event.target === otherField.current;
    if (event.key === "Escape") {
      if (!custom && !typing) return;
      event.preventDefault();
      event.stopPropagation();
      setCustom("");
      firstOption.current?.focus();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      submit(selected, custom);
      return;
    }
    if (typing || !/^[1-9]$/u.test(event.key)) return;
    const index = Number(event.key) - 1;
    const option = item.options[index];
    if (!option) return;
    event.preventDefault();
    event.stopPropagation();
    if (item.multi) {
      setCustom("");
      setSelected((current) =>
        current.includes(option.label)
          ? current.filter((entry) => entry !== option.label)
          : [...current, option.label],
      );
      return;
    }
    setCustom("");
    setSelected([option.label]);
  };

  const groupRole = item.multi ? "group" : "radiogroup";
  return (
    <article
      className={`question-card question-card--${item.status}${item.multi ? " question-card--multi" : ""}${kindClass}`}
      data-question-id={item.id}
      data-question-status={item.status}
      onKeyDown={onKeyDown}
    >
      <p className="question-card-live" aria-live="polite">
        {item.approval ? t("계획 승인 요청") : t("새 질문")}: {item.question}
      </p>
      {head(item.multi ? t("여러 개 고를 수 있어요") : undefined)}
      <p className="question-card-line" id={labelId}>{item.question}</p>
      {item.options.length > 0 && (
        <div
          className="question-card-options"
          role={groupRole}
          aria-labelledby={labelId}
        >
          {item.options.map((option, index) => {
            const checked = selected.includes(option.label);
            return (
              <button
                key={option.label}
                ref={index === 0 ? firstOption : undefined}
                type="button"
                className={`question-option${checked ? " is-selected" : ""}${option.recommended ? " is-recommended" : ""}`}
                role={item.multi ? "checkbox" : "radio"}
                aria-checked={checked}
                disabled={submitting}
                onClick={() => toggle(option.label)}
              >
                <span className="question-option-index" aria-hidden>{index + 1}</span>
                <span className="question-option-label">{option.label}</span>
                {option.recommended && <small>{t("권장")}</small>}
                {item.multi && checked && <Check size={13} aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
      <div className="question-other">
        <input
          ref={otherField}
          value={custom}
          disabled={submitting}
          aria-label={t("직접 입력")}
          placeholder={t("직접 입력")}
          onChange={(event) => {
            setCustom(event.target.value);
            if (event.target.value.trim()) setSelected([]);
          }}
        />
        {(item.multi || item.options.length === 0 || custom.trim()) && (
          <button
            type="button"
            className="question-submit"
            disabled={submitting || (selected.length === 0 && !custom.trim())}
            onClick={() => submit(selected, custom)}
          >
            {item.multi && !custom.trim() ? t("선택 완료") : t("보내기")}
          </button>
        )}
      </div>
      {item.options.length > 0 && (
        <p className="question-card-keys" aria-hidden>
          {t`1–${String(Math.min(item.options.length, 9))} 선택 · Enter 보내기`}
        </p>
      )}
      {item.error && (
        <p className="question-card-error" role="alert">{t(item.error)}</p>
      )}
    </article>
  );
}

/** The pending ask, pinned above the composer so it is not scrolled away. */
export function QuestionBanner({
  pending,
  onAnswer,
}: {
  pending: readonly QuestionActivity[];
  onAnswer: QuestionCardProps["onAnswer"];
}) {
  const current = pending[0];
  if (!current) return null;
  return (
    <div className="question-banner">
      <QuestionCard item={current} onAnswer={onAnswer} autoFocus />
    </div>
  );
}
