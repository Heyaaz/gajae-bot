import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import { DEFAULT_MODEL_PRESET } from "../../shared/agent-contract";
import type { GjcUpdateStatus, ManagementSnapshot } from "../../shared/agent-contract";
import type { AgentControlPreferences, BackendConnection } from "../backend/types";
import { CalendarClock, Check, Command, FolderOpen, ShieldCheck, Smartphone, X } from "lucide-react";
import { useEffect, useState } from "react";
import { connectionStateLabel } from "./format";
import { AutomationPanel, ManagementPanel } from "./panels";
import { Dropdown } from "./primitives";
import { RemoteAccessPanel } from "./remote-access-panel";

export interface SettingsDialogProps {
  connection: BackendConnection;
  onClose: () => void;
  onSaved: (preferences: AgentControlPreferences) => void;
  updateStatus: GjcUpdateStatus | null;
  updateBusy: "checking" | "installing" | null;
  updateError: string;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
}

export function SettingsDialog({
  connection,
  onClose,
  onSaved,
  updateStatus,
  updateBusy,
  updateError,
  onCheckUpdate,
  onInstallUpdate,
}: SettingsDialogProps) {
  const detectedPreset = connection.modelPreset ?? DEFAULT_MODEL_PRESET;
  const fallbackPreferences: AgentControlPreferences = {
    workspace: connection.workspace,
    workspaceLabel: "개인 Workspace",
    modelPreset: detectedPreset,
    permissionHandling: "prompt",
    gjcExecutable: "",
  };
  const [tab, setTab] = useState<
    "gjc" | "workspace" | "remote" | "mcp" | "skills" | "usage" | "automations"
  >("gjc");
  const [management, setManagement] = useState<ManagementSnapshot | null>(null);
  const [managementError, setManagementError] = useState("");
  const [managementLoading, setManagementLoading] = useState(false);
  const [preferences, setPreferences] =
    useState<AgentControlPreferences>(fallbackPreferences);
  const [original, setOriginal] =
    useState<AgentControlPreferences>(fallbackPreferences);
  const [saving, setSaving] = useState(false);
  const settingsBridge = window.agentControlDesktop?.settings;
  const managementBridge = window.agentControlDesktop?.management;
  const dirty = JSON.stringify(preferences) !== JSON.stringify(original);
  const runtimeDirty =
    preferences.modelPreset !== original.modelPreset ||
    preferences.permissionHandling !== original.permissionHandling ||
    preferences.gjcExecutable !== original.gjcExecutable;
  const tabTitle = {
    gjc: "GJC",
    workspace: "Workspace 범위",
    remote: "원격 접속",
    mcp: "MCP 서버",
    skills: "Skills & Plugins",
    usage: "Usage",
    automations: "Automations",
  }[tab];
  const tabDescription = {
    gjc: "GJC 실행 파일과 새 세션이 시작될 모델 프로필·도구 승인 방식을 설정합니다.",
    workspace: "GJC가 확인하고 수정할 폴더를 선택합니다.",
    remote: "휴대폰과 다른 개인 기기에서 이 컴퓨터의 세션을 조회·조작합니다.",
    mcp: "GJC가 자동으로 로드할 MCP 서버를 관리합니다.",
    skills: "발견된 스킬과 설치된 플러그인을 확인합니다.",
    usage: "모델별 토큰, 캐시율, 비용을 확인합니다.",
    automations: "앱이 닫혀 있어도 GJC 작업을 정해진 시간에 실행합니다.",
  }[tab];

  useEffect(() => {
    if (!settingsBridge) return;
    let active = true;
    void settingsBridge.getPreferences().then((loaded) => {
      if (!active) return;
      setPreferences(loaded);
      setOriginal(loaded);
    });
    return () => {
      active = false;
    };
  }, [settingsBridge]);

  useEffect(() => {
    if (
      !managementBridge ||
      management ||
      !["mcp", "skills", "usage"].includes(tab)
    )
      return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setManagementLoading(true);
      setManagementError("");
      void managementBridge
        .getSnapshot(preferences.workspace)
        .then((snapshot) => {
          if (active) setManagement(snapshot);
        })
        .catch((error) => {
          if (active)
            setManagementError(
              error instanceof Error ? error.message : String(error),
            );
        })
        .finally(() => {
          if (active) setManagementLoading(false);
        });
    });
    return () => {
      active = false;
    };
  }, [management, managementBridge, preferences.workspace, tab]);

  async function chooseWorkspace(): Promise<void> {
    if (!settingsBridge) return;
    const selected = await settingsBridge.chooseWorkspace(
      preferences.workspace,
    );
    if (selected) {
      setPreferences((current) => ({ ...current, workspace: selected }));
      setManagement(null);
    }
  }

  async function saveSettings(): Promise<void> {
    if (!settingsBridge || !dirty) return;
    setSaving(true);
    try {
      const saved = await settingsBridge.savePreferences(preferences);
      setPreferences(saved.preferences);
      setOriginal(saved.preferences);
      onSaved(saved.preferences);
      onClose();
    } catch (error) {
      setSaving(false);
      console.error(error);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="설정"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <nav>
          <h2>설정</h2>
          <button
            type="button"
            className={tab === "gjc" ? "is-active" : ""}
            onClick={() => setTab("gjc")}
          >
            <Command size={17} /> GJC
          </button>
          <button
            type="button"
            className={tab === "workspace" ? "is-active" : ""}
            onClick={() => setTab("workspace")}
          >
            <FolderOpen size={17} /> Workspace
          </button>
          <button
            type="button"
            className={tab === "remote" ? "is-active" : ""}
            onClick={() => setTab("remote")}
          >
            <Smartphone size={17} /> 원격 접속
          </button>
          <button
            type="button"
            className={tab === "mcp" ? "is-active" : ""}
            onClick={() => setTab("mcp")}
          >
            MCP
          </button>
          <button
            type="button"
            className={tab === "skills" ? "is-active" : ""}
            onClick={() => setTab("skills")}
          >
            Skills/Plugins
          </button>
          <button
            type="button"
            className={tab === "usage" ? "is-active" : ""}
            onClick={() => setTab("usage")}
          >
            Usage
          </button>
          <button
            type="button"
            className={tab === "automations" ? "is-active" : ""}
            onClick={() => setTab("automations")}
          >
            <CalendarClock size={17} /> Automations
          </button>
        </nav>
        <div className="settings-content">
          <header>
            <div>
              <h2>{tabTitle}</h2>
              <p>{tabDescription}</p>
            </div>
            <button className="icon-button" type="button" onClick={onClose}>
              <X size={19} />
            </button>
          </header>

          {tab === "gjc" && (
            <div className="settings-stack">
              <article className="backend-card">
                <span className="backend-logo backend-logo--gjc">
                  <img src={gajaeIconUrl} alt="" />
                </span>
                <span>
                  <strong>{connection.label}</strong>
                  <small>{connection.detail}</small>
                </span>
                <span
                  className={`ready-badge ready-badge--${connection.state}`}
                >
                  <Check size={13} /> {connectionStateLabel(connection.state)}
                </span>
              </article>
              <div className="settings-panel">
                <label>
                  <span>
                    <strong>모델 프로필</strong>
                    <small>기본 preset 또는 models.yml의 custom ID</small>
                  </span>
                  <input
                    list="gjc-model-profiles"
                    value={preferences.modelPreset}
                    onChange={(event) =>
                      setPreferences((current) => ({
                        ...current,
                        modelPreset: event.target.value,
                      }))
                    }
                    placeholder="codex-medium or custom profile ID"
                  />
                  <datalist id="gjc-model-profiles">
                    <option value="codex-eco" />
                    <option value="codex-medium" />
                    <option value="codex-pro" />
                  </datalist>
                </label>
                <label>
                  <span>
                    <strong>도구 승인</strong>
                    <small>위험한 작업을 GJC가 처리하는 방식</small>
                  </span>
                  <Dropdown
                    value={preferences.permissionHandling}
                    ariaLabel="도구 승인"
                    options={[
                      { value: "prompt", label: "매번 확인" },
                      { value: "auto", label: "GJC 스마트 정책" },
                      { value: "always-allow", label: "항상 허용" },
                    ]}
                    onChange={(value) =>
                      setPreferences((current) => ({
                        ...current,
                        permissionHandling:
                          value as AgentControlPreferences["permissionHandling"],
                      }))
                    }
                  />
                </label>
                <label className="settings-field-wide">
                  <span>
                    <strong>GJC 실행 파일</strong>
                    <small>비워 두면 로컬 설치를 자동으로 찾습니다</small>
                  </span>
                  <input
                    value={preferences.gjcExecutable}
                    placeholder="Auto-detect (~/.bun/bin/gjc)"
                    onChange={(event) =>
                      setPreferences((current) => ({
                        ...current,
                        gjcExecutable: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="gjc-update-row">
                  <span>
                    <strong>GJC 업데이트</strong>
                    <small>
                      {updateError ||
                        (updateStatus
                          ? updateStatus.updateAvailable
                            ? `${updateStatus.currentVersion} → ${updateStatus.latestVersion} 사용 가능`
                            : `최신 버전 ${updateStatus.currentVersion}`
                          : "업데이트 정보를 확인합니다")}
                    </small>
                  </span>
                  <span className="gjc-update-actions">
                    <button
                      type="button"
                      disabled={Boolean(updateBusy)}
                      onClick={onCheckUpdate}
                    >
                      {updateBusy === "checking" ? "확인 중…" : "다시 확인"}
                    </button>
                    {updateStatus?.updateAvailable && (
                      <button
                        type="button"
                        className="button-primary"
                        disabled={Boolean(updateBusy)}
                        onClick={onInstallUpdate}
                      >
                        {updateBusy === "installing"
                          ? "업데이트 중…"
                          : "업데이트"}
                      </button>
                    )}
                  </span>
                </div>
              </div>
            </div>
          )}
          {["mcp", "skills", "usage"].includes(tab) && (
            <div className="settings-stack">
              {managementLoading && (
                <p className="settings-note">불러오는 중…</p>
              )}
              {managementError && (
                <p className="diff-error">{managementError}</p>
              )}
              {!managementLoading &&
                !managementError &&
                management &&
                managementBridge && (
                  <ManagementPanel
                    tab={tab as "mcp" | "skills" | "usage"}
                    snapshot={management}
                    workspace={preferences.workspace}
                    bridge={managementBridge}
                    onSnapshot={setManagement}
                    onError={setManagementError}
                  />
                )}
              {!managementLoading && !managementError && !management && (
                <p className="settings-note">데이터가 없습니다.</p>
              )}
            </div>
          )}
          {tab === "automations" && (
            <AutomationPanel
              defaultWorkspace={preferences.workspace}
              defaultModel={preferences.modelPreset}
            />
          )}

          {tab === "remote" && <RemoteAccessPanel />}

          {tab === "workspace" && (
            <div className="settings-stack">
              <div className="workspace-card">
                <span>
                  <FolderOpen size={22} />
                </span>
                <div>
                  <strong>
                    {preferences.workspace.split("/").filter(Boolean).at(-1) ??
                      preferences.workspace}
                  </strong>
                  <code>{preferences.workspace}</code>
                </div>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void chooseWorkspace()}
                >
                  선택…
                </button>
              </div>
              <div className="scope-notice">
                <ShieldCheck size={17} />
                <span>
                  <strong>폴더 범위</strong>
                  <small>
                    새 GJC 세션은 이 폴더에서 시작하며 파일 작업과 저장소 탐색의
                    기준으로 사용합니다.
                  </small>
                </span>
              </div>
            </div>
          )}

          {/* Remote access applies each change immediately and carries its own
              footnote, so the preferences save bar would be dead weight there. */}
          {tab !== "automations" && tab !== "remote" && (
            <footer className="settings-footer">
              <span>
                {dirty
                  ? runtimeDirty
                    ? "저장하면 GJC runtime만 다시 연결됩니다."
                    : "앱 재실행 없이 바로 적용됩니다."
                  : "설정이 최신 상태입니다."}
              </span>
              <button
                type="button"
                className="button-primary"
                disabled={!dirty || saving || !settingsBridge}
                onClick={() => void saveSettings()}
              >
                {saving
                  ? runtimeDirty
                    ? "GJC 재연결 중…"
                    : "저장 중…"
                  : "저장"}
              </button>
            </footer>
          )}
        </div>
      </section>
    </div>
  );
}
