import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Check, CircleHelp } from "lucide-react";
import type { CliQuestionAnswer, CliQuestionState } from "../../shared/agent-contract";
import { t, useLanguage } from "../i18n";
import type { QuestionCardProps } from "./question-card";

interface CliQuestionCardProps extends QuestionCardProps {
  cli: CliQuestionState;
  QuestionText: (props: { text: string; id?: string }) => ReactNode;
  idempotencyKey: (id: string) => string;
}

/** One authoritative CLI interaction; a new request mounts a new editor and guard. */
export function CliQuestionCard({ item, cli, onAnswer, autoFocus, QuestionText, idempotencyKey }: CliQuestionCardProps) {
  useLanguage();
  const labelId = useId();
  const firstOption = useRef<HTMLButtonElement>(null);
  const firstControl = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(cli.editor?.prefill ?? "");
  const [, redraw] = useState(0);
  const guard = useRef({ status: item.status, error: item.error, revision: cli.rejectionRevision, locked: false });
  if (guard.current.status !== item.status || guard.current.error !== item.error || guard.current.revision !== cli.rejectionRevision) {
    guard.current = { status: item.status, error: item.error, revision: cli.rejectionRevision, locked: false };
  }
  const submitting = guard.current.locked;
  const isEditor = cli.interaction !== "selector";

  useEffect(() => {
    if (!autoFocus) return;
    if (isEditor) editor.current?.focus();
    else (firstOption.current ?? firstControl.current)?.focus();
  }, [autoFocus, isEditor, cli.requestId]);

  const submit = (answer: CliQuestionAnswer): void => {
    if (guard.current.locked) return;
    if (answer.kind === "value" && isEditor && !answer.value.trim()) return;
    guard.current.locked = true;
    redraw((value) => value + 1);
    onAnswer(item.id, {
      selected: [],
      cli: { requestId: cli.requestId, answer },
    }, idempotencyKey(item.id));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" || event.key === "Esc") {
      event.preventDefault();
      event.stopPropagation();
      if (event.target === editor.current) setText("");
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter" && !event.shiftKey) {
      if (isEditor && event.target === editor.current) {
        event.preventDefault();
        event.stopPropagation();
        submit({ kind: "value", value: text });
      } else if (event.target instanceof HTMLButtonElement) {
        event.preventDefault();
        event.stopPropagation();
        event.target.click();
      }
      return;
    }
    if (isEditor || event.shiftKey || !/^[1-9]$/u.test(event.key)) return;
    const option = event.currentTarget.querySelectorAll<HTMLButtonElement>(".question-option")[Number(event.key) - 1];
    if (!option || option.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    option.focus();
  };

  return (
    <article
      className={`question-card question-card--${item.status}${item.multi ? " question-card--multi" : ""}`}
      data-question-id={item.id}
      data-question-status={item.status}
      onKeyDown={onKeyDown}
    >
      <p className="question-card-live" aria-live="polite">{t("새 질문")}: {item.question}</p>
      <header className="question-card-head">
        <CircleHelp size={13} aria-hidden />
        <span>{t("질문")}</span>
        {item.multi && !isEditor && <small>{t("여러 개 고를 수 있어요")}</small>}
      </header>
      <QuestionText text={item.question} id={labelId} />
      {!isEditor && item.options.length > 0 && (
        <div className="question-card-options" role={item.multi ? "group" : "radiogroup"} aria-labelledby={labelId}>
          {item.options.map((option, index) => {
            const checked = cli.selectedOptions.includes(option.label);
            return (
              <button
                key={`${index}:${option.label}`}
                ref={index === 0 ? firstOption : undefined}
                type="button"
                className={`question-option${checked ? " is-selected" : ""}${option.recommended ? " is-recommended" : ""}`}
                role={item.multi ? "checkbox" : "radio"}
                aria-checked={checked}
                disabled={submitting}
                onClick={() => submit({ kind: "value", value: option.label })}
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
      {isEditor && cli.editor?.title && <label className="question-card-line" htmlFor={`${labelId}-editor`}>{cli.editor.title}</label>}
      {isEditor && (
        <div className="question-other">
          <textarea
            ref={editor}
            id={`${labelId}-editor`}
            rows={3}
            value={text}
            disabled={submitting}
            aria-label={cli.editor?.title ?? item.question}
            placeholder={cli.editor?.title ?? item.question}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="button" className="question-submit" disabled={submitting || !text.trim()} onClick={() => submit({ kind: "value", value: text })}>
            {t("보내기")}
          </button>
        </div>
      )}
      {cli.controls.length > 0 && (
        <div className="question-other">
          {cli.controls.map((control, index) => (
            <button
              key={control.id}
              ref={index === cli.controls.findIndex((entry) => entry.enabled) ? firstControl : undefined}
              type="button"
              className="question-submit"
              disabled={submitting || !control.enabled}
              onClick={() => submit({ kind: "control", controlId: control.id })}
            >
              {control.label}
            </button>
          ))}
        </div>
      )}
      {!isEditor && item.options.length > 0 && (
        <p className="question-card-keys" aria-hidden>{t`1–${String(Math.min(item.options.length, 9))} 선택 · Enter 보내기`}</p>
      )}
      {item.error && <p className="question-card-error" role="alert">{t(item.error)}</p>}
    </article>
  );
}
