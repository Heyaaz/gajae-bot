import type { SessionProgress } from "../../shared/agent-contract";
import { endableWorkflow } from "../../shared/session-progress";
import { t, useLanguage } from "../i18n";

/**
 * One compact card per active workflow HUD (ralplan, autoresearch, ...) from
 * `session.progress`: phase, summary, chips by severity, and the review verdict.
 * A workflow GJC can end carries an end button while `onEnd` is given.
 */
export function WorkflowStatusCards({
  progress,
  onEnd,
  endingSkill,
}: {
  progress?: SessionProgress;
  onEnd?: (skill: string) => void;
  endingSkill?: string | null;
}) {
  useLanguage();
  if (!progress || progress.workflows.length === 0) return null;
  return (
    <section className="workflow-status" aria-label={t("진행 중인 워크플로")}>
      {progress.workflows.map((workflow, index) => {
        const chips = workflow.verdict
          ? workflow.chips.filter((chip) => chip.label !== "verdict")
          : workflow.chips;
        return (
          <article
            key={`${workflow.skill}-${index}`}
            className="workflow-status-card"
            data-workflow={workflow.skill}
          >
            <p className="workflow-status-head">
              <strong className="workflow-status-skill">{workflow.skill}</strong>
              <span className="workflow-status-phase">{workflow.phase}</span>
              {workflow.verdict && (
                <span className="workflow-status-verdict">
                  {t`리뷰 ${workflow.verdict}`}
                </span>
              )}
              {onEnd && endableWorkflow(workflow.skill) && (
                <button
                  type="button"
                  className="workflow-status-end"
                  disabled={endingSkill !== null && endingSkill !== undefined}
                  aria-label={t`${workflow.skill} 워크플로 끝내기`}
                  onClick={() => onEnd(workflow.skill)}
                >
                  {endingSkill === workflow.skill ? t("끝내는 중…") : t("워크플로 끝내기")}
                </button>
              )}
            </p>
            {workflow.summary && (
              <p className="workflow-status-summary">{workflow.summary}</p>
            )}
            {chips.length > 0 && (
              <ul className="workflow-status-chips">
                {chips.map((chip, chipIndex) => (
                  <li
                    key={`${chip.label}-${chipIndex}`}
                    className={`workflow-chip workflow-chip--${chip.severity ?? "plain"}`}
                  >
                    <span>{chip.label}</span>
                    {chip.value && <b>{chip.value}</b>}
                  </li>
                ))}
              </ul>
            )}
          </article>
        );
      })}
      {progress.omittedWorkflows > 0 && (
        <p className="workflow-status-more">
          {t`워크플로 ${progress.omittedWorkflows}개 더 있음`}
        </p>
      )}
    </section>
  );
}
