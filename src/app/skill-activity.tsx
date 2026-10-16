import { ChevronRight, Sparkles } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptItem } from "../backend/types";
import { MessageCopyButton } from "./primitives";

export function SkillInvocation({ name, args }: { name: string; args: string }) {
  return (
    <div className="skill-invocation">
      <div className="skill-invocation-heading" aria-label={`스킬 호출: ${name}`}>
        <Sparkles size={14} aria-hidden />
        <span className="skill-invocation-label">스킬</span>
        <strong>{name}</strong>
      </div>
      {args && <p className="skill-invocation-args">{args}</p>}
    </div>
  );
}

export function SkillPromptCard({ item }: { item: Extract<TranscriptItem, { kind: "system" }> }) {
  const [expanded, setExpanded] = useState(false);
  const heading = /^#[\t ]+(.+?)[\t ]*#*[\t ]*$/mu.exec(item.content)?.[1]?.trim();
  const name = heading || (item.title !== "스킬" ? item.title : "스킬 지침");
  return (
    <details className="skill-activity" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="skill-activity-summary">
        <span className="skill-activity-icon"><Sparkles size={15} aria-hidden /></span>
        <span className="skill-activity-name" title={name}>{name}</span>
        <span className="skill-activity-label">스킬 지침</span>
        <span className="skill-activity-action">{expanded ? "원문 접기" : "원문 보기"}</span>
        <ChevronRight className="skill-activity-chevron" size={14} aria-hidden />
      </summary>
      {expanded && (
        <div className="skill-activity-body">
          <div className="skill-activity-toolbar">
            <span>세션에 전달된 스킬 원문</span>
            <MessageCopyButton text={item.content} />
          </div>
          <div className="skill-activity-content markdown-body" role="region" aria-label={`${name} 스킬 원문`} tabIndex={0}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown>
          </div>
        </div>
      )}
    </details>
  );
}
