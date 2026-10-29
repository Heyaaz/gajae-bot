import { FolderGit2, Layers, X } from "lucide-react";
import type { ProjectGroup } from "./project-model";
import { t } from "../i18n";


export interface ProjectListProps {
  projects: readonly ProjectGroup[];
  /** The project the rail is filtered by, or the all-projects sentinel. */
  activeId: string;
  onSelect: (projectId: string) => void;
  /** Opens one project's repository screen; the list is how a project gets chosen. */
  onOpenRepository: (projectId: string) => void;
  onClose: () => void;
}

/**
 * The project list 전체 프로젝트 offers instead of a single 레포 보기.
 *
 * A rail spanning several repositories has no one repository to open, so the entry
 * point leads here and the user names the project first. Every project is listed
 * whether or not it is a Git repository: a plain directory still holds sessions,
 * and hiding it would drop them out of the project view entirely.
 */
export function ProjectList({
  projects,
  activeId,
  onSelect,
  onOpenRepository,
  onClose,
}: ProjectListProps) {
  return (
    <main className="project-list">
      <header className="project-list__header">
        <Layers size={16} />
        <strong>{t("프로젝트 목록")}</strong>
        <small>{projects.length}{t("개 프로젝트")}</small>
        <button
          type="button"
          className="icon-button"
          title={t("대화로 돌아가기")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {projects.length === 0 ? (
        <p className="project-list__empty">
          {t("프로젝트가 없습니다. 세션을 만들면 그 작업 폴더가 프로젝트가 됩니다.")} </p>
      ) : (
        <div className="project-list__rows">
          {projects.map((project) => (
            <article
              key={project.id}
              className={`project-row ${project.id === activeId ? "is-active" : ""}`}
            >
              <button
                type="button"
                className="project-row__select"
                aria-pressed={project.id === activeId}
                onClick={() => onSelect(project.id)}
              >
                <strong>{project.name}</strong>
                <code>{project.root}</code>
                <small>
                  {project.repository ? t("Git 레포") : t("Git 레포 아님")} {t("· 세션")}{" "}
                  {project.sessions.length}{t("개")} </small>
              </button>
              {project.repository ? (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => onOpenRepository(project.id)}
                >
                  <FolderGit2 size={14} /> {t("레포 보기")} </button>
              ) : (
                <span className="project-row__hint">
                  {t("Git 레포가 아니라 레포 화면이 없습니다")} </span>
              )}
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
