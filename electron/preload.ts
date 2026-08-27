import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentEvent,
  AgentControlPreferences,
  CreateSessionInput,
  ForkSessionInput,
  GjcDesktopBridge,
  MessageInput,
  ArtifactContent,
  DiffSnapshot,
  EffectiveRuntimeState,
  SettingsDesktopBridge,
  ToolDecision,
  ManagementDesktopBridge,
  McpServerInput,
} from "../shared/agent-contract.js";
import type { ProductivityDesktopBridge } from "../shared/productivity-ipc.js";
import type {
  AutomationDesktopBridge,
  AutomationInput,
} from "../shared/automation-ipc.js";
import { GJC_IPC } from "../shared/gjc-ipc.js";
import {
  DESKTOP_IPC,
  SETTINGS_IPC,
  type SessionShortcut,
} from "../shared/settings-ipc.js";
import { DESKTOP_SERVICES_IPC as SERVICES_IPC } from "../shared/desktop-services-ipc.js";
import { PRODUCTIVITY_IPC } from "../shared/productivity-ipc.js";
import { AUTOMATION_IPC } from "../shared/automation-ipc.js";

const gjc: GjcDesktopBridge = Object.freeze({
  getConnection: () => ipcRenderer.invoke(GJC_IPC.getConnection),
  listSessions: () => ipcRenderer.invoke(GJC_IPC.listSessions),
  createSession: (input: CreateSessionInput) =>
    ipcRenderer.invoke(GJC_IPC.createSession, input),
  forkSession: (input: ForkSessionInput) =>
    ipcRenderer.invoke(GJC_IPC.forkSession, input),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke(GJC_IPC.renameSession, sessionId, title),
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.deleteSession, sessionId),
  getTranscript: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.getTranscript, sessionId),
  setSessionConfig: (sessionId: string, configId: string, value: string) =>
    ipcRenderer.invoke(GJC_IPC.setSessionConfig, sessionId, configId, value),
  cycleThinking: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.cycleThinking, sessionId),
  compactSession: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.compactSession, sessionId),
  queueFollowUp: (sessionId: string, input: MessageInput) =>
    ipcRenderer.invoke(GJC_IPC.queueFollowUp, sessionId, input),
  listQueuedMessages: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.listQueuedMessages, sessionId),
  flushQueuedNow: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.flushQueuedNow, sessionId),
  steerSession: (sessionId: string, input: MessageInput) =>
    ipcRenderer.invoke(GJC_IPC.steerSession, sessionId, input),
  sendMessage: (sessionId: string, input: MessageInput) =>
    ipcRenderer.invoke(GJC_IPC.sendMessage, sessionId, input),
  cancelRun: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.cancelRun, sessionId),
  resolveToolCall: (toolId: string, decision: ToolDecision) =>
    ipcRenderer.invoke(GJC_IPC.resolveToolCall, toolId, decision),
  markSessionRead: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.markSessionRead, sessionId),
  getDiff: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.getDiff, sessionId) as Promise<DiffSnapshot>,
  readArtifact: (sessionId: string, artifactId: string) =>
    ipcRenderer.invoke(
      GJC_IPC.readArtifact,
      sessionId,
      artifactId,
    ) as Promise<ArtifactContent>,
  previewFile: (sessionId: string, filePath: string) =>
    ipcRenderer.invoke(GJC_IPC.previewFile, sessionId, filePath),
  getGoal: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.getGoal, sessionId),
  operateGoal: (
    sessionId: string,
    operation: import("../shared/agent-contract.js").GoalOperation,
  ) => ipcRenderer.invoke(GJC_IPC.operateGoal, sessionId, operation),
  listSubagents: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.listSubagents, sessionId),
  refreshRuntimeState: (sessionId: string) =>
    ipcRenderer.invoke(
      GJC_IPC.refreshRuntimeState,
      sessionId,
    ) as Promise<EffectiveRuntimeState>,
  reconnect: () => ipcRenderer.invoke(GJC_IPC.reconnect),
  getGitStatus: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.getGitStatus, sessionId),
  stageFiles: (sessionId: string, paths: string[]) =>
    ipcRenderer.invoke(GJC_IPC.stageFiles, sessionId, paths),
  unstageFiles: (sessionId: string, paths: string[]) =>
    ipcRenderer.invoke(GJC_IPC.unstageFiles, sessionId, paths),
  commitChanges: (sessionId: string, message: string) =>
    ipcRenderer.invoke(GJC_IPC.commitChanges, sessionId, message),
  pushChanges: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.pushChanges, sessionId),
  onEvent: (listener: (event: AgentEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AgentEvent) =>
      listener(payload);
    ipcRenderer.on(GJC_IPC.event, wrapped);
    return () => ipcRenderer.removeListener(GJC_IPC.event, wrapped);
  },
});

const settings: SettingsDesktopBridge = Object.freeze({
  getPreferences: () => ipcRenderer.invoke(SETTINGS_IPC.getPreferences),
  chooseWorkspace: (currentPath: string) =>
    ipcRenderer.invoke(SETTINGS_IPC.chooseWorkspace, currentPath),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  readImages: (paths: string[]) =>
    ipcRenderer.invoke(SETTINGS_IPC.readImages, paths),
  readFiles: (paths: string[]) =>
    ipcRenderer.invoke(SETTINGS_IPC.readFiles, paths),
  setWorkspaceLabel: (label: string) =>
    ipcRenderer.invoke(SETTINGS_IPC.setWorkspaceLabel, label),
  savePreferences: (preferences: AgentControlPreferences) =>
    ipcRenderer.invoke(SETTINGS_IPC.savePreferences, preferences),
  checkGjcUpdate: () => ipcRenderer.invoke(SETTINGS_IPC.checkGjcUpdate),
  installGjcUpdate: () => ipcRenderer.invoke(SETTINGS_IPC.installGjcUpdate),
});
const management: ManagementDesktopBridge = Object.freeze({
  getSnapshot: (w: string) =>
    ipcRenderer.invoke(SERVICES_IPC.management.getSnapshot, w),
  addMcpServer: (w: string, i: McpServerInput) =>
    ipcRenderer.invoke(SERVICES_IPC.management.addMcpServer, w, i),
  removeMcpServer: (w: string, s: "user" | "project", n: string) =>
    ipcRenderer.invoke(SERVICES_IPC.management.removeMcpServer, w, s, n),
  setPluginEnabled: (w: string, n: string, e: boolean) =>
    ipcRenderer.invoke(SERVICES_IPC.management.setPluginEnabled, w, n, e),
  installPlugin: (w: string, target: string, scope: "user" | "project") =>
    ipcRenderer.invoke(SERVICES_IPC.management.installPlugin, w, target, scope),
  uninstallPlugin: (w: string, n: string) =>
    ipcRenderer.invoke(SERVICES_IPC.management.uninstallPlugin, w, n),
});
const productivity: ProductivityDesktopBridge = Object.freeze({
  previewLink: (url: string) =>
    ipcRenderer.invoke(PRODUCTIVITY_IPC.previewLink, url),
  searchTranscripts: (query: string, limit?: number) =>
    ipcRenderer.invoke(PRODUCTIVITY_IPC.searchTranscripts, query, limit),
  rebuildSearch: () => ipcRenderer.invoke(PRODUCTIVITY_IPC.rebuildSearch),
});
const automations: AutomationDesktopBridge = Object.freeze({
  list: () => ipcRenderer.invoke(AUTOMATION_IPC.list),
  create: (input: AutomationInput) =>
    ipcRenderer.invoke(AUTOMATION_IPC.create, input),
  updateEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(AUTOMATION_IPC.updateEnabled, { id, enabled }),
  delete: (id: string) => ipcRenderer.invoke(AUTOMATION_IPC.delete, id),
  listRuns: (automationId?: string) =>
    ipcRenderer.invoke(AUTOMATION_IPC.listRuns, automationId),
  runNow: (id: string) => ipcRenderer.invoke(AUTOMATION_IPC.runNow, id),
});
contextBridge.exposeInMainWorld(
  "agentControlDesktop",
  Object.freeze({
    platform: process.platform,
    versions: Object.freeze({
      chrome: process.versions.chrome,
      electron: process.versions.electron,
    }),
    gjc,
    settings,
    management,
    productivity,
    automations,
    onCycleEffort: (listener: () => void) => {
      const wrapped = () => listener();
      ipcRenderer.on(DESKTOP_IPC.cycleEffort, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_IPC.cycleEffort, wrapped);
    },
    onAbortRun: (listener: () => void) => {
      const wrapped = () => listener();
      ipcRenderer.on(DESKTOP_IPC.abortRun, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_IPC.abortRun, wrapped);
    },
    onSessionShortcut: (listener: (shortcut: SessionShortcut) => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        shortcut: SessionShortcut,
      ) => listener(shortcut);
      ipcRenderer.on(DESKTOP_IPC.sessionShortcut, wrapped);
      return () =>
        ipcRenderer.removeListener(DESKTOP_IPC.sessionShortcut, wrapped);
    },
  }),
);
