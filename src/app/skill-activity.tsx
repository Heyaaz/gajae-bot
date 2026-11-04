import { ChevronRight, Sparkles } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { TranscriptItem } from "../backend/types";
import { MARKDOWN_REMARK_PLUGINS } from "./markdown-plugins";
import { MessageCopyButton } from "./primitives";
import { t } from "../i18n";


/**
 * A `/skill:` request as the user sent it. Long arguments (a verification brief
 * can run to a paragraph) start clamped so the reply below stays in view; the
 * toggle appears only when the clamp actually hides something.
 */
export function SkillInvocation({ name, args }: { name: string; args: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const argsRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = argsRef.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [args, expanded]);
  return (
    <div className="skill-invocation">
      <div className="skill-invocation-heading" aria-label={t`스킬 호출: ${name}`}>
        <Sparkles size={14} aria-hidden />
        <span className="skill-invocation-label">{t("스킬")}</span>
        <strong>{name}</strong>
        {args && (overflows || expanded) && (
          <button
            type="button"
            className="thought-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? t("접기") : t("펼치기")}
          </button>
        )}
      </div>
      {args && (
        <p ref={argsRef} className={`skill-invocation-args${expanded ? "" : " is-clamped"}`}>
          {args}
        </p>
      )}
    </div>
  );
}

export function SkillPromptCard({ item }: { item: Extract<TranscriptItem, { kind: "system" }> }) {
  const [expanded, setExpanded] = useState(false);
  const heading = /^#[\t ]+(.+?)[\t ]*#*[\t ]*$/mu.exec(item.content)?.[1]?.trim();
  const name = heading || (item.title !== "스킬" ? item.title : t("스킬 지침"));
  return (
    <details className="skill-activity" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="skill-activity-summary">
        <span className="skill-activity-icon"><Sparkles size={15} aria-hidden /></span>
        <span className="skill-activity-name" title={name}>{name}</span>
        <span className="skill-activity-label">{t("스킬 지침")}</span>
        <span className="skill-activity-action">{expanded ? t("원문 접기") : t("원문 보기")}</span>
        <ChevronRight className="skill-activity-chevron" size={14} aria-hidden />
      </summary>
      {expanded && (
        <div className="skill-activity-body">
          <div className="skill-activity-toolbar">
            <span>{t("세션에 전달된 스킬 원문")}</span>
            <MessageCopyButton text={item.content} />
          </div>
          <div className="skill-activity-content markdown-body" role="region" aria-label={t`${name} 스킬 원문`} tabIndex={0}>
            <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{item.content}</ReactMarkdown>
          </div>
        </div>
      )}
    </details>
  );
}
