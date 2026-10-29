import { Inbox, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  Automation,
  AutomationDesktopBridge,
  AutomationRun,
} from "../../shared/automation-ipc";
import type { AgentSession, TranscriptItem } from "../backend/types";
import { t, useLanguage } from "../i18n";
import { sessionTitleText } from "./format";
import {
  buildInbox,
  elapsedLabel,
  type InboxItem,
  type InboxSectionId,
} from "./inbox-model";
import type { ProjectGroup } from "./project-model";

export interface InboxViewProps {
  sessions: readonly AgentSession[];
  projects: readonly ProjectGroup[];
  transcripts: Readonly<Record<string, readonly TranscriptItem[] | undefined>>;
  /** The desktop's automation service; absent in the remote client. */
  automations?: AutomationDesktopBridge;
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
}

function sectionLabel(id: InboxSectionId): string {
  switch (id) {
    case "waiting":
      return t("승인·질문 대기");
    case "failed":
      return t("실패");
    case "completed":
      return t("새로 완료");
    default:
      return t("실행 중");
  }
}

function stateClass(item: InboxItem): string {
  if (item.kind === "automation-run") return item.run.status;
  return item.session.phase === "compacting"
    ? "compacting"
    : item.session.status;
}

/**
 * Everything across every project that is waiting on the user, failed, finished
 * unseen, or still running, in one list.
 *
 * Opening a session goes through the shell's own selection, which is what marks it
 * read; an automation run has no conversation to open, so its row unfolds the
 * output instead.
 */
export function InboxView({
  sessions,
  projects,
  transcripts,
  automations,
  onOpenSession,
  onClose,
}: InboxViewProps) {
  useLanguage();
  const [now, setNow] = useState(() => Date.now());
  const [automationData, setAutomationData] = useState<{
    automations: Automation[];
    runs: AutomationRun[];
  }>({ automations: [], runs: [] });
  const [automationError, setAutomationError] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!automations) return;
    let active = true;
    void Promise.all([automations.list(), automations.listRuns()])
      .then(([list, runs]) => {
        if (active) setAutomationData({ automations: list, runs });
      })
      .catch(() => {
        if (active) setAutomationError(true);
      });
    return () => {
      active = false;
    };
  }, [automations]);

  useEffect(() => {
    function closeWithEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as { tagName?: unknown } | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      event.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [onClose]);

  const sections = useMemo(
    () =>
      buildInbox({
        sessions,
        projects,
        transcripts,
        automations: automationData.automations,
        runs: automationData.runs,
        now,
      }),
    [sessions, projects, transcripts, automationData, now],
  );
  const total = sections.reduce(
    (sum, section) => sum + section.items.length,
    0,
  );

  function renderItem(item: InboxItem) {
    const elapsed =
      item.at !== undefined
        ? elapsedLabel(item.at, now)
        : item.kind === "session"
          ? item.session.updatedAt
          : "";
    const runOpen = item.kind === "automation-run" && openRun === item.run.id;
    return (
      <li key={item.key} className="inbox-row" data-kind={item.kind}>
        <button
          type="button"
          className="inbox-row__button"
          aria-expanded={item.kind === "automation-run" ? runOpen : undefined}
          onClick={() => {
            if (item.kind === "session") onOpenSession(item.session.id);
            else setOpenRun(runOpen ? null : item.run.id);
          }}
        >
          <span
            className={`session-state-dot session-state-dot--${stateClass(item)}`}
            aria-hidden="true"
          />
          <span className="inbox-row__copy">
            <span className="inbox-row__topline">
              <strong>
                {item.kind === "session"
                  ? sessionTitleText(item.title)
                  : item.title}
              </strong>
              {item.kind === "automation-run" && (
                <span className="inbox-row__tag">{t("자동화")}</span>
              )}
              <time>{elapsed}</time>
            </span>
            <span className="inbox-row__project">{item.project}</span>
            {item.preview && (
              <span className="inbox-row__preview">{item.preview}</span>
            )}
          </span>
          {item.kind === "session" && item.session.unread && (
            <span className="unread-dot" aria-label={t("새 활동")} />
          )}
        </button>
        {runOpen && item.kind === "automation-run" && (
          <pre className="inbox-row__output">
            {[item.run.error, item.run.output].filter(Boolean).join("\n\n") ||
              t("출력이 없습니다.")}
          </pre>
        )}
      </li>
    );
  }

  return (
    <main className="inbox-view" aria-label="Inbox">
      <header className="inbox-view__header">
        <Inbox size={16} aria-hidden="true" />
        <strong>Inbox</strong>
        <small>{t`${total}개 항목`}</small>
        <kbd>⌥⌘U</kbd>
        <button
          type="button"
          className="icon-button"
          title={t("대화로 돌아가기")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {automationError && (
        <p className="inbox-view__notice">
          {t("자동화 실행 결과를 읽지 못했습니다.")}
        </p>
      )}
      {sections.length === 0 ? (
        <p className="inbox-view__empty">
          {t("지금 확인할 세션이 없습니다.")}
        </p>
      ) : (
        <div className="inbox-view__sections">
          {sections.map((section) => (
            <section
              key={section.id}
              className="inbox-section"
              data-section={section.id}
              aria-label={sectionLabel(section.id)}
            >
              <header>
                <span>{sectionLabel(section.id)}</span>
                <small>{section.items.length}</small>
              </header>
              <ul>{section.items.map(renderItem)}</ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
