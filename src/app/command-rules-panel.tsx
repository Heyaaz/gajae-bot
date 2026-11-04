import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { SettingsDesktopBridge } from "../../shared/agent-contract";
import type { ProjectCommandRules } from "../../shared/command-rules";
import { t } from "../i18n";
import { projectNameOf } from "./project-model";

type Bridge = Pick<SettingsDesktopBridge, "listCommandRules" | "removeCommandRule">;

/**
 * The bash allow and reject rules saved per project from approval cards.
 *
 * Rules live in the desktop host, so a renderer without that bridge (the remote
 * web client) shows nothing: a view-only device must not read or change them.
 */
export function CommandRulesPanel({ bridge }: { bridge: Bridge | undefined }) {
  const [projects, setProjects] = useState<ProjectCommandRules[] | null>(null);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    bridge.listCommandRules().then(
      (next) => {
        if (!active) return;
        setProjects(next);
        setError("");
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [bridge]);

  if (!bridge) return null;

  async function remove(root: string, prefix: string) {
    setRemoving(true);
    setError("");
    try {
      setProjects(await bridge!.removeCommandRule(root, prefix));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoving(false);
    }
  }

  const sorted = [...(projects ?? [])].sort((a, b) =>
    projectNameOf(a.root).localeCompare(projectNameOf(b.root)) || a.root.localeCompare(b.root),
  );

  return (
    <section className="settings-panel command-rules" aria-label={t("명령 규칙")}>
      <div className="gjc-update-row">
        <span>
          <strong>{t("명령 규칙")}</strong>
          <small>
            {t("승인 카드에서 저장한, 프로젝트별로 묻지 않고 허용하거나 거절할 bash 명령의 앞부분입니다.")}
          </small>
        </span>
      </div>
      {error && <p className="diff-error">{error}</p>}
      {projects && sorted.length === 0 && !error && (
        <p className="settings-note">
          {t("저장된 명령 규칙이 없습니다. 승인 카드의 앞부분 항상 허용·거부로 추가할 수 있습니다.")}
        </p>
      )}
      {sorted.map((project) => (
        <section className="command-rules-project" key={project.root}>
          <h3>
            {projectNameOf(project.root)}
            <small>{project.root}</small>
          </h3>
          {project.rules.map((rule) => (
            <div className="command-rule-row" key={rule.prefix}>
              <em className={`command-rule-decision command-rule-decision--${rule.decision}`}>
                {rule.decision === "allow" ? t("허용") : t("거절")}
              </em>
              <code>{rule.prefix}</code>
              <button
                type="button"
                aria-label={t("{0} 규칙 삭제", { 0: rule.prefix })}
                disabled={removing}
                onClick={() => void remove(project.root, rule.prefix)}
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            </div>
          ))}
        </section>
      ))}
    </section>
  );
}
