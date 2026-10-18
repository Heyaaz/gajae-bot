import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import {
  DEFAULT_MODEL_PRESET,
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_SOUNDS,
} from "../../shared/agent-contract";
import type {
  GjcUpdateStatus,
  ManagementSnapshot,
  NotificationCategory,
  NotificationPreferences,
} from "../../shared/agent-contract";
import type { AgentControlPreferences, BackendConnection } from "../backend/types";
import { Bell, CalendarClock, Check, Command, FolderOpen, ShieldCheck, Smartphone, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { connectionStateLabel } from "./format";
import { AutomationPanel, ManagementPanel } from "./panels";
import { Dropdown } from "./primitives";
import { RemoteAccessPanel } from "./remote-access-panel";

export interface SettingsDialogProps {
  connection: BackendConnection;
  /**
   * The shell's current reasoning-card preference.
   *
   * The dialog seeds its own object from it so a card toggled moments before opening
   * settings is not clobbered by a draft built from an older read.
   */
  thoughtsExpanded: boolean;
  onClose: () => void;
  onSaved: (preferences: AgentControlPreferences) => void;
  updateStatus: GjcUpdateStatus | null;
  updateBusy: "checking" | "installing" | null;
  updateError: string;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
}

/**
 * The preferences to show once the first read lands.
 *
 * A draft built from the fallback values is only authoritative for the fields the
 * user actually touched. Keeping the whole draft (the old behavior) saved those
 * fallbacks over every other stored setting -- a custom executable, workspace and
 * permission mode were replaced because one field was edited during the read.
 */
export function mergeInitialPreferences(
  current: AgentControlPreferences,
  loaded: AgentControlPreferences,
  editedFields: readonly (keyof AgentControlPreferences)[],
): { preferences: AgentControlPreferences; original: AgentControlPreferences } {
  if (editedFields.length === 0) return { preferences: loaded, original: loaded };
  const preferences: AgentControlPreferences = { ...loaded };
  for (const field of editedFields) {
    (preferences as Record<keyof AgentControlPreferences, unknown>)[field] =
      current[field];
  }
  return { preferences, original: loaded };
}

/**
 * What a completed save may do to the dialog that asked for it.
 *
 * A save is asynchronous and the user can keep editing or close and reopen the
 * dialog while it runs. The response must not replace those newer edits, and a
 * response owned by an unmounted dialog must not close the one now on screen.
 */
export function resolvePreferenceSave(input: {
  mounted: boolean;
  revisionAtSave: number;
  revisionNow: number;
  current: AgentControlPreferences;
  saved: AgentControlPreferences;
}): {
  notify: boolean;
  close: boolean;
  preferences: AgentControlPreferences;
  original: AgentControlPreferences;
} {
  if (!input.mounted) {
    return {
      notify: false,
      close: false,
      preferences: input.current,
      original: input.current,
    };
  }
  const sameDraft = input.revisionAtSave === input.revisionNow;
  return {
    notify: true,
    close: sameDraft,
    // A newer edit is the draft now; adopting the older save response would
    // silently discard it. The saved values still become the compare baseline.
    preferences: sameDraft ? input.saved : input.current,
    original: input.saved,
  };
}

/**
 * Saving is only allowed against a completed read.
 *
 * The fallback-loaded draft is not the stored configuration. Saving it after a
 * failed read would replace every untouched setting with a default, so the dialog
 * waits for the read instead.
 */
export function canSavePreferences(
  dirty: boolean,
  saving: boolean,
  hasBridge: boolean,
  loaded: boolean,
): boolean {
  return dirty && !saving && hasBridge && loaded;
}

export function settingsErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const NOTIFICATION_ROWS: ReadonlyArray<{
  key: NotificationCategory;
  label: string;
  detail: string;
}> = [
  {
    key: "completed",
    label: "작업 완료",
    detail: "실행 중인 턴이 정상적으로 끝났을 때",
  },
  {
    key: "permission",
    label: "승인·질문 대기",
    detail: "도구 승인이나 사용자의 답변을 기다릴 때",
  },
  {
    key: "failed",
    label: "실패",
    detail: "턴이 오류로 끝났을 때",
  },
  {
    key: "message",
    label: "새 응답",
    detail: "턴 밖의 보조 메시지와 연결 복구",
  },
];

const NOTIFICATION_SOUND_LABELS: Record<
  (typeof NOTIFICATION_SOUNDS)[number],
  string
> = {
  default: "기본",
  none: "없음",
  Glass: "Glass",
  Ping: "Ping",
  Pop: "Pop",
  Submarine: "Submarine",
};

export function SettingsDialog({
  connection,
  thoughtsExpanded,
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
    thoughtsExpanded,
    notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
    runningSubmission: "queue",
  };
  const [tab, setTab] = useState<
    | "gjc"
    | "workspace"
    | "remote"
    | "mcp"
    | "skills"
    | "usage"
    | "notifications"
    | "automations"
  >("gjc");
  const [management, setManagement] = useState<ManagementSnapshot | null>(null);
  const [managementError, setManagementError] = useState("");
  const [managementLoading, setManagementLoading] = useState(false);
  const [preferences, setPreferences] =
    useState<AgentControlPreferences>(fallbackPreferences);
  const [original, setOriginal] =
    useState<AgentControlPreferences>(fallbackPreferences);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const editedBeforeLoad = useRef(new Set<keyof AgentControlPreferences>());
  const editRevision = useRef(0);
  const mounted = useRef(true);
  const preferencesRef = useRef(preferences);
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
    notifications: "알림",
    automations: "Automations",
  }[tab];
  const tabDescription = {
    gjc: "GJC 실행 파일과 새 세션이 시작될 모델 프로필·도구 승인 방식을 설정합니다.",
    workspace: "GJC가 확인하고 수정할 폴더를 선택합니다.",
    remote: "휴대폰과 다른 개인 기기에서 이 컴퓨터의 세션을 조회·조작합니다.",
    mcp: "GJC가 자동으로 로드할 MCP 서버를 관리합니다.",
    skills: "발견된 스킬과 설치된 플러그인을 확인합니다.",
    usage: "모델별 토큰, 캐시율, 비용을 확인합니다.",
    notifications:
      "완료·승인/질문 대기·실패를 이벤트별로 알리고 소리를 고릅니다.",
    automations: "앱이 닫혀 있어도 GJC 작업을 정해진 시간에 실행합니다.",
  }[tab];

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!settingsBridge) return;
    let active = true;
    void settingsBridge
      .getPreferences()
      .then((loaded) => {
        if (!active) return;
        const result = mergeInitialPreferences(
          preferencesRef.current,
          loaded,
          [...editedBeforeLoad.current],
        );
        preferencesRef.current = result.preferences;
        setPreferences(result.preferences);
        setOriginal(result.original);
        setLoadError("");
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(settingsErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [loadAttempt, settingsBridge]);

  async function persistRunningSubmission(
    value: "queue" | "steer",
  ): Promise<void> {
    if (!settingsBridge) return;
    const previous = preferencesRef.current.runningSubmission;
    const optimistic = { ...preferencesRef.current, runningSubmission: value };
    preferencesRef.current = optimistic;
    setPreferences(optimistic);
    setSaveError("");
    try {
      const saved = await settingsBridge.setRunningSubmission(value);
      const current = { ...preferencesRef.current, runningSubmission: saved };
      preferencesRef.current = current;
      setPreferences(current);
      setOriginal((original) => ({
        ...original,
        runningSubmission: saved,
      }));
    } catch (error) {
      const restored = {
        ...preferencesRef.current,
        runningSubmission: previous,
      };
      preferencesRef.current = restored;
      setPreferences(restored);
      setSaveError(settingsErrorMessage(error));
    }
  }

  async function persistNotifications(
    next: NotificationPreferences,
  ): Promise<void> {
    if (!settingsBridge) return;
    const previous = preferencesRef.current.notificationPreferences;
    const optimistic = {
      ...preferencesRef.current,
      notificationPreferences: next,
    };
    preferencesRef.current = optimistic;
    setPreferences(optimistic);
    setSaveError("");
    try {
      const saved = await settingsBridge.setNotificationPreferences(next);
      const current = {
        ...preferencesRef.current,
        notificationPreferences: saved,
      };
      preferencesRef.current = current;
      setPreferences(current);
      setOriginal((value) => ({
        ...value,
        notificationPreferences: saved,
      }));
    } catch (error) {
      const restored = {
        ...preferencesRef.current,
        notificationPreferences: previous,
      };
      preferencesRef.current = restored;
      setPreferences(restored);
      setSaveError(settingsErrorMessage(error));
    }
  }

  function editPreferences(
    update: (current: AgentControlPreferences) => AgentControlPreferences,
  ): void {
    editRevision.current += 1;
    const current = preferencesRef.current;
    const next = update(current);
    if (!loaded) {
      for (const field of Object.keys(next) as (keyof AgentControlPreferences)[]) {
        if (next[field] !== current[field]) editedBeforeLoad.current.add(field);
      }
    }
    preferencesRef.current = next;
    setPreferences(next);
    setSaveError("");
  }

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
    setWorkspaceError("");
    try {
      const selected = await settingsBridge.chooseWorkspace(
        preferences.workspace,
      );
      if (selected) {
        editPreferences((current) => ({ ...current, workspace: selected }));
        setManagement(null);
      }
    } catch (error) {
      setWorkspaceError(settingsErrorMessage(error));
    }
  }

  async function saveSettings(): Promise<void> {
    if (!settingsBridge || !canSavePreferences(dirty, saving, true, loaded)) return;
    const revisionAtSave = editRevision.current;
    setSaving(true);
    setSaveError("");
    try {
      const saved = await settingsBridge.savePreferences(preferences);
      const outcome = resolvePreferenceSave({
        mounted: mounted.current,
        revisionAtSave,
        revisionNow: editRevision.current,
        current: preferencesRef.current,
        saved: saved.preferences,
      });
      if (!outcome.notify) return;
      preferencesRef.current = outcome.preferences;
      setPreferences(outcome.preferences);
      setOriginal(outcome.original);
      onSaved(outcome.original);
      if (outcome.close) onClose();
    } catch (error) {
      if (mounted.current) setSaveError(settingsErrorMessage(error));
    } finally {
      if (mounted.current) setSaving(false);
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
            className={tab === "notifications" ? "is-active" : ""}
            onClick={() => setTab("notifications")}
          >
            <Bell size={17} /> 알림
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

          {workspaceError && <p className="diff-error" role="alert">폴더를 선택하지 못했습니다: {workspaceError}</p>}
          {loadError && (
            <p className="diff-error" role="alert">
              설정을 불러오지 못했습니다: {loadError}
              <button
                type="button"
                className="button-secondary"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                다시 시도
              </button>
            </p>
          )}
          {saveError && (
            <p className="diff-error" role="alert">
              설정을 저장하지 못했습니다: {saveError}
            </p>
          )}

          {tab === "notifications" && (
            <div className="settings-stack">
              <p className="settings-note">
                지금 보고 있는 세션의 완료·실패·승인 알림은 생략합니다. 창이
                앞에 있어도 다른 세션의 결과는 알립니다. 원격 PWA에는 같은
                이벤트의 읽지 않은 세션 수가 앱 배지로 표시됩니다.
              </p>
              <div className="settings-panel">
                {NOTIFICATION_ROWS.map((row) => {
                  const preference =
                    preferences.notificationPreferences[row.key];
                  return (
                    <div className="settings-toggle-row" key={row.key}>
                      <span>
                        <strong>{row.label}</strong>
                        <small>{row.detail}</small>
                      </span>
                      <span className="notification-controls">
                        <input
                          type="checkbox"
                          aria-label={`${row.label} 알림`}
                          checked={preference.enabled}
                          disabled={!settingsBridge}
                          onChange={(event) =>
                            void persistNotifications({
                              ...preferencesRef.current
                                .notificationPreferences,
                              [row.key]: {
                                ...preference,
                                enabled: event.target.checked,
                              },
                            })
                          }
                        />
                        <Dropdown
                          value={preference.sound}
                          ariaLabel={`${row.label} 알림 소리`}
                          options={NOTIFICATION_SOUNDS.map((sound) => ({
                            value: sound,
                            label: NOTIFICATION_SOUND_LABELS[sound],
                          }))}
                          onChange={(sound) =>
                            void persistNotifications({
                              ...preferencesRef.current
                                .notificationPreferences,
                              [row.key]: {
                                ...preference,
                                sound: sound as (typeof NOTIFICATION_SOUNDS)[number],
                              },
                            })
                          }
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

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
                      editPreferences((current) => ({
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
                      editPreferences((current) => ({
                        ...current,
                        permissionHandling:
                          value as AgentControlPreferences["permissionHandling"],
                      }))
                    }
                  />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <strong>추론 카드 펼치기</strong>
                    <small>추론(thinking) 기록을 모든 세션에서 펼친 상태로 둡니다</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={preferences.thoughtsExpanded}
                    onChange={(event) =>
                      editPreferences((current) => ({
                        ...current,
                        thoughtsExpanded: event.target.checked,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>
                    <strong>실행 중 Enter</strong>
                    <small>
                      턴이 실행 중일 때 Enter로 제출하면 보류(Queue)할지 다음
                      경계에서 반영(Steer)할지 고릅니다. /queue·/steer는 항상 이
                      설정보다 우선합니다.
                    </small>
                  </span>
                  <Dropdown
                    value={preferences.runningSubmission}
                    ariaLabel="실행 중 Enter 동작"
                    options={[
                      { value: "queue", label: "보류 후 턴 종료 시 전송 (Queue)" },
                      { value: "steer", label: "다음 경계에서 바로 반영 (Steer)" },
                    ]}
                    onChange={(value) =>
                      void persistRunningSubmission(value as "queue" | "steer")
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
                      editPreferences((current) => ({
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
                {!loaded
                  ? "설정을 불러온 뒤 저장할 수 있습니다."
                  : dirty
                    ? runtimeDirty
                      ? "저장하면 GJC runtime만 다시 연결됩니다."
                      : "앱 재실행 없이 바로 적용됩니다."
                    : "설정이 최신 상태입니다."}
              </span>
              <button
                type="button"
                className="button-primary"
                disabled={
                  !canSavePreferences(
                    dirty,
                    saving,
                    Boolean(settingsBridge),
                    loaded,
                  )
                }
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
