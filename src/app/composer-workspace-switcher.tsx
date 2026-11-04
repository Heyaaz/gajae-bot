import { Check, ChevronDown, FolderGit2, FolderOpen } from "lucide-react";
import { t } from "../i18n";
import { directoryName } from "./format";

interface WorkspaceSwitcherProps {
  workspace: string;
  workspaces: string[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onChange: (workspace: string) => void;
  onBrowse: () => Promise<void>;
}

export function WorkspaceSwitcher({ workspace, workspaces, open: workspaceOpen, onToggle, onClose, onChange, onBrowse }: WorkspaceSwitcherProps) {
  return (
          <span className="workspace-switcher">
            <button
              className="composer-context"
              type="button"
              title={workspace}
              onClick={onToggle}
            >
              <FolderGit2 size={15} /> {directoryName(workspace)}{" "}
              <ChevronDown size={13} />
            </button>
            {workspaceOpen && (
              <span className="workspace-menu">
                <strong>{t("세션을 시작할 workspace")}</strong>
                {workspaces.map((candidate) => (
                  <button
                    type="button"
                    key={candidate}
                    className={candidate === workspace ? "is-current" : ""}
                    onClick={() => {
                      onClose();
                      if (candidate !== workspace) onChange(candidate);
                    }}
                  >
                    <FolderGit2 size={14} />
                    <span>
                      {directoryName(candidate)}
                      <small>{candidate}</small>
                    </span>
                    {candidate === workspace && <Check size={13} />}
                  </button>
                ))}
                <button type="button" onClick={() => void onBrowse()}>
                  <FolderOpen size={14} />
                  <span>{t("다른 폴더 선택…")}</span>
                </button>
              </span>
            )}
          </span>
  );
}
