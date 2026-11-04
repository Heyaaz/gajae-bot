import { ChevronRight, Sparkles } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ToolViewMode, TranscriptItem } from "../backend/types";
import { MARKDOWN_REMARK_PLUGINS } from "./markdown-plugins";
import { MessageCopyButton } from "./primitives";
import { t } from "../i18n";


/** How much of a `/skill:` request's arguments the card shows. */
export type SkillArgsView = "hidden" | "line" | "full";

/** The transcript's display mode decides where each card starts. */
export const SKILL_ARGS_VIEW: Record<ToolViewMode, SkillArgsView> = {
  basic: "hidden",
  reasoning: "line",
  detailed: "full",
};

/**
 * A `/skill:` request as the user sent it. A card's toggle overrides the mode's
 * starting view for that card until the mode changes. The toggle appears only
 * when folding would actually hide something.
 */
export function SkillInvocation({
  name,
  args,
  initialView = "line",
}: {
  name: string;
  args: string;
  initialView?: SkillArgsView;
}) {
  const [choice, setChoice] = useState({ base: initialView, view: initialView });
  // A mode change drops the card's own choice, so returning to a mode does not
  // bring back what the card was toggled to before.
  if (choice.base !== initialView) setChoice({ base: initialView, view: initialView });
  const view = choice.base === initialView ? choice.view : initialView;
  const folded: SkillArgsView = initialView === "full" ? "line" : initialView;
  const [long, setLong] = useState(false);
  const argsRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = argsRef.current;
    if (!element) return;
    const measure = () => {
      if (view === "line") {
        setLong(element.scrollHeight > element.clientHeight + 1);
        return;
      }
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
      setLong(element.clientHeight > lineHeight * 1.5);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [args, view]);
  const expanded = view === "full";
  const toggle = Boolean(args) && (view === "hidden" || folded === "hidden" || long);
  return (
    <div className="skill-invocation">
      <div className="skill-invocation-heading" aria-label={t`스킬 호출: ${name}`}>
        <Sparkles size={14} aria-hidden />
        <span className="skill-invocation-label">{t("스킬")}</span>
        <strong>{name}</strong>
        {toggle && (
          <button
            type="button"
            className="thought-toggle"
            aria-expanded={expanded}
            onClick={() => setChoice({ base: initialView, view: expanded ? folded : "full" })}
          >
            {expanded ? t("접기") : t("펼치기")}
          </button>
        )}
      </div>
      {args && view !== "hidden" && (
        <p ref={argsRef} className={`skill-invocation-args${view === "line" ? " is-clamped" : ""}`}>
          {args}
        </p>
      )}
    </div>
  );
}

export function SkillPromptCard({ item }: { item: Extract<TranscriptItem, { kind: "system" }> }) {
  const [expanded, setExpanded] = useState(false);
  const name = item.skillName ? t`${item.skillName} 지침` : t("스킬 지침");
  return (
    <details className="skill-activity" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="skill-activity-summary">
        <span className="skill-activity-icon"><Sparkles size={15} aria-hidden /></span>
        <span className="skill-activity-name" title={name}>{name}</span>
        <span className="skill-activity-label">{t("스킬")}</span>
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
