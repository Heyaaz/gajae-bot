import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import {
  BUILT_IN_MODEL_PRESETS,
  DEFAULT_MODEL_PRESET,
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_TOOL_VIEW_MODE,
  NOTIFICATION_SOUNDS,
} from "../../shared/agent-contract";
import type {
  GjcUpdateStatus,
  ManagementSnapshot,
  NotificationCategory,
  NotificationPreferences,
} from "../../shared/agent-contract";
import type { AgentControlPreferences, BackendConnection } from "../backend/types";
import { Bell, CalendarClock, ChartNoAxesColumn, Check, Command, FolderOpen, Monitor, Palette, Server, ShieldCheck, Smartphone, Sparkles, Stethoscope, X } from "lucide-react";
import {
  DEFAULT_DESKTOP_INTEGRATION,
  type DesktopIntegrationPreferences,
} from "../../shared/desktop-integration";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { connectionStateLabel } from "./format";
import { readStoredTheme, setThemeMode, type ThemeMode } from "../theme";
import { getLanguage, setLanguageMode, t, useLanguageMode } from "../i18n";
import { LazyViewBoundary } from "./lazy-boundary";
import { AutomationPanel, ManagementPanel } from "./panels";
import { Dropdown } from "./primitives";
import { AppUpdateRow } from "./app-update-row";
import { EnvironmentCheckPanel } from "./environment-check-panel";
const RemoteAccessPanel = lazy(() =>
  import("./remote-access-panel").then((mod) => ({ default: mod.RemoteAccessPanel })),
);

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
  /** The tab to open on; the launch environment check opens on its own tab. */
  initialTab?: SettingsTab;
}

export type SettingsTab =
  | "gjc"
  | "appearance"
  | "workspace"
  | "remote"
  | "mcp"
  | "skills"
  | "usage"
  | "notifications"
  | "desktop"
  | "environment"
  | "automations";

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
  return t(error instanceof Error ? error.message : String(error));
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
  initialTab = "gjc",
}: SettingsDialogProps) {
  const detectedPreset = connection.modelPreset ?? DEFAULT_MODEL_PRESET;
  const fallbackPreferences: AgentControlPreferences = {
    workspace: connection.workspace,
    workspaceLabel: t("개인 Workspace"),
    modelPreset: detectedPreset,
    permissionHandling: "prompt",
    gjcExecutable: "",
    thoughtsExpanded,
    toolViewMode: DEFAULT_TOOL_VIEW_MODE,
    notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
    desktopIntegration: DEFAULT_DESKTOP_INTEGRATION,
    language: getLanguage(),
    runningSubmission: "queue",
  };
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => readStoredTheme());
  const languageMode = useLanguageMode();
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
    appearance: t("모양"),
    workspace: t("Workspace 범위"),
    remote: t("원격 접속"),
    mcp: t("MCP 서버"),
    skills: "Skills & Plugins",
    usage: "Usage",
    notifications: t("알림"),
    desktop: t("데스크톱"),
    environment: t("환경 점검"),
    automations: "Automations",
  }[tab];
  const tabDescription = {
    gjc: t("GJC 실행 파일과 새 세션이 시작될 모델 프로필·도구 승인 방식을 설정합니다."),
    appearance: t("앱의 테마와 표시 언어를 설정합니다."),
    workspace: t("GJC가 확인하고 수정할 폴더를 선택합니다."),
    remote: t("휴대폰과 다른 개인 기기에서 이 컴퓨터의 세션을 조회·조작합니다."),
    mcp: t("GJC가 자동으로 로드할 MCP 서버를 관리합니다."),
    skills: t("발견된 스킬과 설치된 플러그인을 확인합니다."),
    usage: t("모델별 토큰, 캐시율, 비용을 확인합니다."),
    notifications:
      t("완료·승인/질문 대기·실패를 이벤트별로 알리고 소리를 고릅니다."),
    desktop: t("창 밖에서 동작하는 기능을 설정합니다."),
    environment: t("Gajae가 쓰는 도구가 이 Mac에 준비됐는지 확인합니다."),
    automations: t("앱이 닫혀 있어도 GJC 작업을 정해진 시간에 실행합니다."),
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

  async function persistDesktopIntegration(
    next: DesktopIntegrationPreferences,
  ): Promise<void> {
    if (!settingsBridge) return;
    const previous = preferencesRef.current.desktopIntegration;
    const optimistic = { ...preferencesRef.current, desktopIntegration: next };
    preferencesRef.current = optimistic;
    setPreferences(optimistic);
    setSaveError("");
    try {
      const saved = await settingsBridge.setDesktopIntegration(next);
      const current = { ...preferencesRef.current, desktopIntegration: saved };
      preferencesRef.current = current;
      setPreferences(current);
      setOriginal((value) => ({ ...value, desktopIntegration: saved }));
    } catch (error) {
      const restored = {
        ...preferencesRef.current,
        desktopIntegration: previous,
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
        aria-label={t("설정")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <nav>
          <h2>{t("설정")}</h2>
          <button
            type="button"
            className={tab === "gjc" ? "is-active" : ""}
            onClick={() => setTab("gjc")}
          >
            <Command size={17} /> GJC
          </button>
          <button
            type="button"
            className={tab === "appearance" ? "is-active" : ""}
            onClick={() => setTab("appearance")}
          >
            <Palette size={17} /> {t("모양")} </button>
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
            <Smartphone size={17} /> {t("원격 접속")} </button>
          <button
            type="button"
            className={tab === "notifications" ? "is-active" : ""}
            onClick={() => setTab("notifications")}
          >
            <Bell size={17} /> {t("알림")} </button>
          <button
            type="button"
            className={tab === "desktop" ? "is-active" : ""}
            onClick={() => setTab("desktop")}
          >
            <Monitor size={17} /> {t("데스크톱")} </button>
          <button
            type="button"
            className={tab === "environment" ? "is-active" : ""}
            onClick={() => setTab("environment")}
          >
            <Stethoscope size={17} /> {t("환경 점검")} </button>
          <button
            type="button"
            className={tab === "mcp" ? "is-active" : ""}
            onClick={() => setTab("mcp")}
          >
            <Server size={17} /> MCP
          </button>
          <button
            type="button"
            className={tab === "skills" ? "is-active" : ""}
            onClick={() => setTab("skills")}
          >
            <Sparkles size={17} /> Skills/Plugins
          </button>
          <button
            type="button"
            className={tab === "usage" ? "is-active" : ""}
            onClick={() => setTab("usage")}
          >
            <ChartNoAxesColumn size={17} /> Usage
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

          {workspaceError && <p className="diff-error" role="alert">{t("폴더를 선택하지 못했습니다:")} {workspaceError}</p>}
          {loadError && (
            <p className="diff-error" role="alert">
              {t("설정을 불러오지 못했습니다:")} {loadError}
              <button
                type="button"
                className="button-secondary"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                {t("다시 시도")} </button>
            </p>
          )}
          {saveError && (
            <p className="diff-error" role="alert">
              {t("설정을 저장하지 못했습니다:")} {saveError}
            </p>
          )}

          {tab === "appearance" && (
            <div className="settings-stack">
              <div className="settings-panel">
                <div className="settings-toggle-row">
                  <span>
                    <strong>{t("테마")}</strong>
                    <small>{t("앱 전체의 밝기 모드를 선택합니다.")}</small>
                  </span>
                  <Dropdown
                    ariaLabel={t("테마")}
                    value={themeMode}
                    options={[
                      { value: "light", label: t("화이트") },
                      { value: "dark", label: t("블랙") },
                      { value: "system", label: t("시스템") },
                    ]}
                    onChange={(value) => {
                      const mode = value as ThemeMode;
                      setThemeMode(mode);
                      setThemeModeState(mode);
                    }}
                  />
                </div>
              </div>
              <div className="settings-panel">
                <div className="settings-toggle-row">
                  <span>
                    <strong>{t("표시 언어")}</strong>
                    <small>{t("앱 전체에 표시할 언어를 선택합니다.")}</small>
                  </span>
                  <Dropdown
                    ariaLabel={t("표시 언어")}
                    value={languageMode}
                    options={[
                      { value: "ko", label: t("한국어") },
                      { value: "en", label: "English" },
                      { value: "system", label: t("시스템") },
                    ]}
                    onChange={(value) => {
                      const resolved = setLanguageMode(value as typeof languageMode);
                      const next = {
                        ...preferencesRef.current,
                        language: resolved,
                      };
                      preferencesRef.current = next;
                      setPreferences(next);
                      setOriginal((original) => ({ ...original, language: resolved }));
                      setSaveError("");
                      if (settingsBridge) {
                        void settingsBridge
                          .setLanguage(resolved)
                          .catch((error: unknown) =>
                            setSaveError(settingsErrorMessage(error)),
                          );
                      }
                    }}
                  />
                </div>
              </div>
              <p className="settings-note">
                {t(
                  "시스템은 macOS의 화면 모드를 따르며, 변경 즉시 앱 전체에 적용됩니다.",
                )}
              </p>
              <p className="settings-note">
                {t("언어를 바꾸면 현재 창에 즉시 적용됩니다.")}
              </p>
            </div>
          )}

          {tab === "notifications" && (
            <div className="settings-stack">
              <p className="settings-note">
                {t("지금 보고 있는 세션의 완료·실패·승인 알림은 생략합니다. 창이 앞에 있어도 다른 세션의 결과는 알립니다. 원격 PWA에는 같은 이벤트의 읽지 않은 세션 수가 앱 배지로 표시됩니다.")} </p>
              <div className="settings-panel">
                {NOTIFICATION_ROWS.map((row) => {
                  const preference =
                    preferences.notificationPreferences[row.key];
                  const label = t(row.label);
                  return (
                    <div className="settings-toggle-row" key={row.key}>
                      <span>
                        <strong>{label}</strong>
                        <small>{t(row.detail)}</small>
                      </span>
                      <span className="notification-controls">
                        <input
                          type="checkbox"
                          aria-label={t`${label} 알림`}
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
                          ariaLabel={t`${label} 알림 소리`}
                          options={NOTIFICATION_SOUNDS.map((sound) => ({
                            value: sound,
                            label: t(NOTIFICATION_SOUND_LABELS[sound]),
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

          {tab === "desktop" && (
            <div className="settings-stack">
              <div className="settings-panel">
                {(
                  [
                    {
                      key: "preventSleep",
                      label: t("실행 중 잠자기 방지"),
                      detail: t("세션이 작업 중일 때만 Mac이 잠들지 않게 합니다. 모든 작업이 끝나면 해제합니다."),
                    },
                    {
                      key: "menuBarStatus",
                      label: t("메뉴바 상태 표시"),
                      detail: t("실행 중인 세션과 확인이 필요한 세션 수를 메뉴바에 표시합니다. 눌러서 세션으로 바로 이동할 수 있습니다."),
                    },
                    {
                      key: "dockBadge",
                      label: t("Dock 배지"),
                      detail: t("승인·질문 대기, 실패, 안 읽은 완료 세션 수를 Dock 아이콘에 표시합니다."),
                    },
                    {
                      key: "checkAppUpdates",
                      label: t("Gajae 업데이트 확인"),
                      detail: t("배포된 앱은 시작할 때와 하루에 한 번 GitHub 릴리스를 확인하고, 새 버전마다 한 번만 알립니다. 앱을 내려받거나 바꾸지는 않습니다."),
                    },
                  ] as const
                ).map((row) => (
                  <div className="settings-toggle-row" key={row.key}>
                    <span>
                      <strong>{row.label}</strong>
                      <small>{row.detail}</small>
                    </span>
                    <input
                      type="checkbox"
                      aria-label={row.label}
                      checked={preferences.desktopIntegration[row.key]}
                      disabled={!settingsBridge}
                      onChange={(event) =>
                        void persistDesktopIntegration({
                          ...preferencesRef.current.desktopIntegration,
                          [row.key]: event.target.checked,
                        })
                      }
                    />
                  </div>
                ))}
                <AppUpdateRow bridge={settingsBridge} />
              </div>
            </div>
          )}

          {tab === "environment" && (
            <EnvironmentCheckPanel bridge={settingsBridge} />
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
                    <strong>{t("모델 프로필")}</strong>
                    <small>{t("기본 preset 또는 models.yml의 custom ID")}</small>
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
                    {BUILT_IN_MODEL_PRESETS.map((preset) => (
                      <option key={preset} value={preset} />
                    ))}
                  </datalist>
                </label>
                <label>
                  <span>
                    <strong>{t("도구 승인")}</strong>
                    <small>{t("위험한 작업을 GJC가 처리하는 방식")}</small>
                  </span>
                  <Dropdown
                    value={preferences.permissionHandling}
                    ariaLabel={t("도구 승인")}
                    options={[
                      { value: "prompt", label: t("매번 확인") },
                      { value: "auto", label: t("GJC 스마트 정책") },
                      { value: "always-allow", label: t("항상 허용") },
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
                    <strong>{t("추론 카드 펼치기")}</strong>
                    <small>{t("추론(thinking) 기록을 모든 세션에서 펼친 상태로 둡니다")}</small>
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
                    <strong>{t("실행 중 Enter")}</strong>
                    <small>
                      {t("턴이 실행 중일 때 Enter로 제출하면 보류(Queue)할지 다음 경계에서 반영(Steer)할지 고릅니다. /queue·/steer는 항상 이 설정보다 우선합니다.")} </small>
                  </span>
                  <Dropdown
                    value={preferences.runningSubmission}
                    ariaLabel={t("실행 중 Enter 동작")}
                    options={[
                      { value: "queue", label: t("보류 후 턴 종료 시 전송 (Queue)") },
                      { value: "steer", label: t("다음 경계에서 바로 반영 (Steer)") },
                    ]}
                    onChange={(value) =>
                      void persistRunningSubmission(value as "queue" | "steer")
                    }
                  />
                </label>
                <label className="settings-field-wide">
                  <span>
                    <strong>{t("GJC 실행 파일")}</strong>
                    <small>{t("비워 두면 로컬 설치를 자동으로 찾습니다")}</small>
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
                    <strong>{t("GJC 업데이트")}</strong>
                    <small>
                      {updateError ||
                        (updateStatus
                          ? updateStatus.updateAvailable
                            ? t`${updateStatus.currentVersion} → ${updateStatus.latestVersion} 사용 가능`
                            : t`최신 버전 ${updateStatus.currentVersion}`
                          : t("업데이트 정보를 확인합니다"))}
                    </small>
                  </span>
                  <span className="gjc-update-actions">
                    <button
                      type="button"
                      disabled={Boolean(updateBusy)}
                      onClick={onCheckUpdate}
                    >
                      {updateBusy === "checking" ? t("확인 중…") : t("다시 확인")}
                    </button>
                    {updateStatus?.updateAvailable && (
                      <button
                        type="button"
                        className="button-primary"
                        disabled={Boolean(updateBusy)}
                        onClick={onInstallUpdate}
                      >
                        {updateBusy === "installing"
                          ? t("업데이트 중…")
                          : t("업데이트")}
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
                <p className="settings-note">{t("불러오는 중…")}</p>
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
                <p className="settings-note">{t("데이터가 없습니다.")}</p>
              )}
            </div>
          )}
          {tab === "automations" && (
            <AutomationPanel
              defaultWorkspace={preferences.workspace}
              defaultModel={preferences.modelPreset}
            />
          )}

          {tab === "remote" && (
            <LazyViewBoundary>
              <Suspense fallback={null}>
                <RemoteAccessPanel />
              </Suspense>
            </LazyViewBoundary>
          )}

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
                  {t("선택…")} </button>
              </div>
              <div className="scope-notice">
                <ShieldCheck size={17} />
                <span>
                  <strong>{t("폴더 범위")}</strong>
                  <small>
                    {t("새 GJC 세션은 이 폴더에서 시작하며 파일 작업과 저장소 탐색의 기준으로 사용합니다.")} </small>
                </span>
              </div>
            </div>
          )}

          {/* Remote access applies each change immediately and carries its own
              footnote, so the preferences save bar would be dead weight there. */}
          {tab !== "automations" && tab !== "remote" && tab !== "appearance" && (
            <footer className="settings-footer">
              <span>
                {!loaded
                  ? t("설정을 불러온 뒤 저장할 수 있습니다.")
                  : dirty
                    ? runtimeDirty
                      ? t("저장하면 GJC runtime만 다시 연결됩니다.")
                      : t("앱 재실행 없이 바로 적용됩니다.")
                    : t("설정이 최신 상태입니다.")}
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
                    ? t("GJC 재연결 중…")
                    : t("저장 중…")
                  : t("저장")}
              </button>
            </footer>
          )}
        </div>
      </section>
    </div>
  );
}
