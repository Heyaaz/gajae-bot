import type { TranscriptItem } from "../backend/types";
import type { MessageDeliveryAttempt } from "../message-delivery";
import { deliveryAttemptNeedsAttention, messageDeliveryRequestText } from "../message-delivery";
import {
  GitFork,
  Paperclip,
  Shrink,
  TerminalSquare,
} from "lucide-react";
import { useState } from "react";
import { locale, t } from "../i18n";
import { MarkdownBody } from "./transcript-markdown";

export function CompactionCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "compaction" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const tokens = item.tokensBefore.toLocaleString(locale());
  const preview = item.shortSummary || item.summary;
  return (
    <article className={`compaction-card ${expanded ? "is-expanded" : ""}`}>
      <header>
        <Shrink size={15} />
        <strong>compaction</strong>
        <span>{tokens} {t("토큰에서 압축됨")}</span>
      </header>
      <button
        type="button"
        className="compaction-toggle"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? t("요약 접기") : t("요약 펼치기")}
      </button>
      {expanded ? (
        <div className="compaction-summary markdown-body">
          <MarkdownBody>{item.summary}</MarkdownBody>
        </div>
      ) : (
        preview && (
          <div className="compaction-short markdown-body">
            <MarkdownBody>{preview}</MarkdownBody>
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
        <span>{t("분기 요약")}</span>
      </header>
      <button
        type="button"
        className="compaction-toggle"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? t("요약 접기") : t("요약 펼치기")}
      </button>
      {expanded && (
        <div className="compaction-summary markdown-body">
          <MarkdownBody>{item.summary}</MarkdownBody>
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
            <MarkdownBody>{item.content}</MarkdownBody>
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
          {expanded ? t("접기") : t("더 보기")}
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
        <MarkdownBody>{expanded ? item.content : preview}</MarkdownBody>
      </div>
      {truncated && (
        <button
          type="button"
          className="compaction-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("접기") : t("더 보기")}
        </button>
      )}
    </article>
  );
}

export function MessageDeliveryRow({
  attempt,
  onRetry,
}: {
  attempt: MessageDeliveryAttempt;
  onRetry?: (attemptId: string) => void;
}) {
  const text = messageDeliveryRequestText(attempt.input);
  const needsAttention = deliveryAttemptNeedsAttention(attempt);
  return (
    <article
      className={`message message--user${needsAttention ? " message--delivery-failed" : ""}`}
    >
      {text && <div className="message-body">{text}</div>}
      {attempt.input.images.length > 0 && (
        <div className="message-images">
          {attempt.input.images.map((image) => (
            <img
              key={image.id}
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={image.name}
              title={image.name}
            />
          ))}
        </div>
      )}
      {attempt.input.files.length > 0 && (
        <ul className="message-attachments">
          {attempt.input.files.map((file) => (
            <li key={file.id}>
              <Paperclip size={12} aria-hidden />
              <span>{file.name}</span>
            </li>
          ))}
        </ul>
      )}
      {needsAttention && (
        <div className="message-meta">
          <span role="status">
            {attempt.failure?.kind === "not_executed"
              ? t`요청이 실행되지 않았습니다: ${attempt.failure.detail}`
              : attempt.state === "unconfirmed"
                ? t("전달 결과를 알 수 없습니다. 아직 대기 중일 수 있습니다.")
                : t("전달 상태를 기록에서 확인하지 못했습니다.")}
          </span>
          {onRetry && (
            <button
              type="button"
              className="notice-card-retry"
              disabled={attempt.retrying || attempt.submitting}
              onClick={() => {
                if (
                  attempt.state === "unconfirmed" &&
                  !window.confirm(t("전달 결과를 확인할 수 없습니다. 아직 대기 중일 수 있어 다시 시도하면 중복 실행될 수 있습니다. 그래도 다시 시도할까요?"))
                )
                  return;
                onRetry(attempt.id);
              }}
            >
              {attempt.state === "unconfirmed"
                ? t("결과 알 수 없음 · 다시 시도")
                : t("전달 안 됨 · 다시 보내기")}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
