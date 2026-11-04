import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import type { TranscriptItem } from "../backend/types";
import { QuestionCard } from "./question-card";
import {
  attachmentSummaryText,
  copyableMessageText,
  parseSkillInvocation,
} from "../transcript-utils";
import { Brain, Check, ListChecks, Paperclip } from "lucide-react";
import { memo } from "react";
import { httpUrls } from "./format";
import { LinkPreviewCard, MessageCopyButton } from "./primitives";
import { SkillInvocation, SkillPromptCard, type SkillArgsView } from "./skill-activity";
import { t, useLanguage } from "../i18n";
import { BranchSummaryCard, CompactionCard, SystemNoticeCard } from "./transcript-cards";
import { MarkdownBody, StreamingMarkdown } from "./transcript-markdown";
import { TodoCard } from "./transcript-todo";
import { ToolCard } from "./transcript-tool-card";
import type { TranscriptProps } from "./transcript";

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
  skillArgsView = "line",
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
  skillArgsView?: SkillArgsView;
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
              <SkillInvocation name={skill.name} args={skill.args} initialView={skillArgsView} />
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
        answeredAbove
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
