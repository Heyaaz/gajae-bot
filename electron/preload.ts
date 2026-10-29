import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentEvent,
  AgentSession,
  AgentControlPreferences,
  BackendConnection,
  CreateSessionInput,
  ForkSessionInput,
  GjcDesktopBridge,
  MessageInput,
  QuestionSubmission,
  ArtifactContent,
  DiffSnapshot,
  EffectiveRuntimeState,
  SettingsDesktopBridge,
  ToolDecision,
  ToolViewMode,
  TranscriptPageRequest,
  ManagementDesktopBridge,
  McpServerInput,
  NotificationPreferences,
  UiLanguage,
} from "../shared/agent-contract.js";
import type { ProductivityDesktopBridge } from "../shared/productivity-ipc.js";
import type { DesktopIntegrationPreferences } from "../shared/desktop-integration.js";
import type {
  RemoteDesktopBridge,
  RemotePermission,
} from "../shared/remote-protocol.js";
import { REMOTE_IPC } from "../shared/remote-ipc.js";
import type {
  AutomationDesktopBridge,
  AutomationInput,
} from "../shared/automation-ipc.js";
import { GJC_IPC, type GjcEventStreamDescriptor } from "../shared/gjc-ipc.js";
import {
  DESKTOP_IPC,
  SETTINGS_IPC,
  type SessionShortcut,
} from "../shared/settings-ipc.js";
import { DESKTOP_SERVICES_IPC as SERVICES_IPC } from "../shared/desktop-services-ipc.js";
import { PRODUCTIVITY_IPC } from "../shared/productivity-ipc.js";
import { AUTOMATION_IPC } from "../shared/automation-ipc.js";
import { REPO_IPC } from "../shared/repo-ipc.js";
import type { RepoDesktopBridge } from "../shared/repo-ipc.js";
import {
  TERMINAL_IPC,
  type TerminalDesktopBridge,
  type TerminalExitEvent,
  type TerminalOutputEvent,
  type TerminalStartRequest,
} from "../shared/terminal-ipc.js";

/**
 * The desktop event stream.
 *
 * Runtime events do not travel over IPC any more: the main process serves them from a
 * loopback HTTP response as Server-Sent Events, and this preload is its only client. The
 * window keeps calling `onEvent` exactly as it did, so nothing above the bridge knows the
 * delivery changed.
 *
 * The fetch lives here instead of in the renderer because the renderer's Content
 * Security Policy forbids every network destination (`connect-src 'none'`), while a
 * sandboxed preload runs in an isolated world whose requests are not subject to the
 * document's policy. The stream is authenticated with a per-process secret that main
 * hands out over the authorized `GJC_IPC.eventStream` channel.
 *
 * A frame can also be a resync notice. The server's replay buffer is bounded, so a window
 * whose cursor fell out of it is told a gap exists rather than being left to believe its
 * view is complete. The notice is logged: this window rebuilds state through the ordinary
 * IPC reads, and there is no snapshot call to refresh from here.
 */
const DESKTOP_STREAM_RETRY_MS = 1000;
const DESKTOP_STREAM_MAX_RETRY_MS = 15_000;

const eventListeners = new Set<(event: AgentEvent) => void>();
let eventStreamEndpoint: Promise<GjcEventStreamDescriptor | null> | undefined;
/** The one attach/read/retry loop, so two subscribers can never open two streams. */
let eventStreamTask: Promise<void> | undefined;
let eventStreamAbort: AbortController | undefined;
let eventStreamRetryMs = DESKTOP_STREAM_RETRY_MS;
let eventStreamAttached = false;
let eventStreamLastId = 0;

function eventStreamDescriptor(): Promise<GjcEventStreamDescriptor | null> {
  eventStreamEndpoint = ipcRenderer
    .invoke(GJC_IPC.eventStream)
    .then((value: unknown) => {
      const candidate = value as Partial<GjcEventStreamDescriptor> | null;
      if (
        !candidate ||
        typeof candidate.port !== "number" ||
        typeof candidate.token !== "string"
      ) {
        console.error("Desktop event stream discovery returned an invalid descriptor");
        return null;
      }
      return {
        port: candidate.port,
        token: candidate.token,
        seq: typeof candidate.seq === "number" ? candidate.seq : 0,
      };
    })
    .catch((error) => {
      console.error("Unable to discover desktop event stream", error);
      return null;
    });
  return eventStreamEndpoint;
}

function startEventStream(): void {
  if (eventStreamTask) return;
  eventStreamTask = runEventStream().finally(() => {
    eventStreamTask = undefined;
  });
}

function stopEventStream(): void {
  eventStreamRetryMs = DESKTOP_STREAM_RETRY_MS;
  eventStreamAbort?.abort();
  eventStreamAbort = undefined;
}

/**
 * Attaches once and keeps re-attaching while the window has listeners.
 *
 * Each attempt reads from the last frame this window saw, so a stream that dropped is
 * resumed instead of restarted, and the server answers with the frames in between.
 */
async function runEventStream(): Promise<void> {
  for (;;) {
    if (eventListeners.size === 0) return;
    const descriptor = await eventStreamDescriptor();
    if (!descriptor) {
      const wait = eventStreamRetryMs;
      eventStreamRetryMs = Math.min(wait * 2, DESKTOP_STREAM_MAX_RETRY_MS);
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    if (!eventStreamAttached) {
      // The first attach reads from the cursor main took when this window was created, so
      // an event published while the document was still loading is delivered rather than
      // lost; a reload starts from the current position instead of replaying history.
      eventStreamLastId = descriptor.seq;
      eventStreamAttached = true;
    }
    const controller = new AbortController();
    eventStreamAbort = controller;
    // An incomplete SSE frame belongs to this response only. Replaying it into
    // the next response can corrupt an otherwise complete replayed frame.
    let pending = "";
    try {
      const response = await fetch(
        `http://127.0.0.1:${descriptor.port}/events?since=${eventStreamLastId}`,
        {
          headers: { Authorization: `Bearer ${descriptor.token}` },
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body)
        throw new Error(`the event stream answered ${response.status}`);
      eventStreamRetryMs = DESKTOP_STREAM_RETRY_MS;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        pending = dispatchEventFrames(pending);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        console.error("Desktop event stream failed", error);
    } finally {
      // Drop the truncated tail when this particular connection ends.
      pending = "";
      if (eventStreamAbort === controller) eventStreamAbort = undefined;
    }
    if (eventListeners.size === 0) return;
    const wait = eventStreamRetryMs;
    eventStreamRetryMs = Math.min(wait * 2, DESKTOP_STREAM_MAX_RETRY_MS);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** Frames are separated by a blank line; the trailing partial frame is kept. */
function dispatchEventFrames(pending: string): string {
  let rest = pending;
  for (;;) {
    const separator = rest.indexOf("\n\n");
    if (separator === -1) return rest;
    handleEventFrame(rest.slice(0, separator));
    rest = rest.slice(separator + 2);
  }
}

function handleEventFrame(frame: string): void {
  let id: number | undefined;
  let name = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value =
      separator === -1 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "id") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed) && parsed >= 0) id = parsed;
    } else if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }
  if (id !== undefined) eventStreamLastId = id;
  if (data.length === 0) return;
  if (name === "resync") {
    void resyncAfterReplayGap();
    return;
  }
  let event: AgentEvent;
  try {
    event = JSON.parse(data.join("\n")) as AgentEvent;
  } catch (error) {
    console.error("Desktop event stream delivered an unreadable frame", error);
    return;
  }
  for (const listener of [...eventListeners]) {
    try {
      listener(event);
    } catch (error) {
      // One broken listener must not end the stream for the others.
      console.error("Desktop event listener failed", error);
    }
  }
}

/**
 * Sessions the renderer is actually showing or holding in its transcript cache.
 *
 * A replay gap used to read every session's transcript. The cache keeps three,
 * so the rest of that work was discarded. Unset means the renderer has not
 * reported a cache yet, and the gap still reads every session.
 */
let watchedTranscriptIds: ReadonlySet<string> | undefined;
let watchedTranscriptKey: string | undefined;

async function resyncAfterReplayGap(): Promise<void> {
  try {
    const sessions = (await ipcRenderer.invoke(GJC_IPC.listSessions)) as AgentSession[];
    const watched = watchedTranscriptIds;
    for (const session of sessions) {
      for (const listener of [...eventListeners]) {
        try {
          listener({ type: "session.updated", session });
        } catch (error) {
          console.error("Desktop event listener failed during resync", error);
        }
      }
      if (watched && !watched.has(session.id)) continue;
      for (const listener of [...eventListeners]) {
        try {
          listener({ type: "transcript.invalidated", sessionId: session.id });
        } catch (error) {
          console.error("Desktop event listener failed during resync", error);
        }
      }
    }
  } catch (error) {
    console.error("Desktop event stream resync failed", error);
    let connection: BackendConnection;
    try {
      connection = (await ipcRenderer.invoke(
        GJC_IPC.getConnection,
      )) as BackendConnection;
    } catch (connectionError) {
      console.error("Unable to read connection state after event resync failure", connectionError);
      connection = {
        state: "error",
        backend: "gjc",
        label: "Gajae Code",
        detail: "Unable to resynchronize desktop events",
        workspace: "",
      };
    }
    const failed: BackendConnection = {
      ...connection,
      state: "error",
      detail: `Unable to resynchronize desktop events: ${String(error)}`,
    };
    for (const listener of [...eventListeners]) {
      try {
        listener({ type: "connection.updated", connection: failed });
      } catch (listenerError) {
        console.error("Desktop event listener failed during resync", listenerError);
      }
    }
  }
}

const gjc: GjcDesktopBridge = Object.freeze({
  getConnection: () => ipcRenderer.invoke(GJC_IPC.getConnection),
  listSessions: () => ipcRenderer.invoke(GJC_IPC.listSessions),
  createSession: (input: CreateSessionInput) =>
    ipcRenderer.invoke(GJC_IPC.createSession, input),
  forkSession: (input: ForkSessionInput) =>
    ipcRenderer.invoke(GJC_IPC.forkSession, input),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke(GJC_IPC.renameSession, sessionId, title),
  resumeSession: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.resumeSession, sessionId),
  listHistorySessions: () => ipcRenderer.invoke(GJC_IPC.listHistorySessions),
  openHistorySession: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.openHistorySession, sessionId),
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.deleteSession, sessionId),
  hideSession: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.hideSession, sessionId),
  getTranscript: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.getTranscript, sessionId),
  getTranscriptPage: (sessionId: string, request?: TranscriptPageRequest) =>
    ipcRenderer.invoke(GJC_IPC.getTranscriptPage, sessionId, request),
  getTranscriptChanges: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.getTranscriptChanges, sessionId),
  getTranscriptRevision: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.getTranscriptRevision, sessionId),
  watchTranscripts: (sessionIds: readonly string[]) => {
    const key = sessionIds.join("\0");
    if (key === watchedTranscriptKey) return;
    watchedTranscriptKey = key;
    watchedTranscriptIds = new Set(sessionIds);
    void ipcRenderer
      .invoke(GJC_IPC.watchTranscripts, [...sessionIds])
      .catch(() => undefined);
  },
  refreshSessionContext: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.refreshSessionContext, sessionId),
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
  answerQuestion: (
    sessionId: string,
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ) =>
    ipcRenderer.invoke(
      GJC_IPC.answerQuestion,
      sessionId,
      gateId,
      submission,
      idempotencyKey,
    ),
  listPendingQuestions: (sessionId: string) =>
    ipcRenderer.invoke(GJC_IPC.listPendingQuestions, sessionId),
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
    eventListeners.add(listener);
    startEventStream();
    return () => {
      if (!eventListeners.delete(listener)) return;
      if (eventListeners.size === 0) stopEventStream();
    };
  },
});

const settings: SettingsDesktopBridge = Object.freeze({
  getPreferences: () => ipcRenderer.invoke(SETTINGS_IPC.getPreferences),
  chooseWorkspace: (currentPath: string) =>
    ipcRenderer.invoke(SETTINGS_IPC.chooseWorkspace, currentPath),
  isNativeFile: (file: File) => Boolean(webUtils.getPathForFile(file)),
  prepareImages: (files: File[]) =>
    ipcRenderer.invoke(SETTINGS_IPC.prepareImages, files.map((file) => ({
      path: webUtils.getPathForFile(file), name: file.name, type: file.type, size: file.size,
    }))),
  prepareFiles: (files: File[]) =>
    ipcRenderer.invoke(SETTINGS_IPC.prepareFiles, files.map((file) => ({
      path: webUtils.getPathForFile(file), name: file.name, type: file.type, size: file.size,
    }))),
  discardAttachments: (tokens: string[]) =>
    ipcRenderer.invoke(SETTINGS_IPC.discardAttachments, tokens),
  setWorkspaceLabel: (label: string) =>
    ipcRenderer.invoke(SETTINGS_IPC.setWorkspaceLabel, label),
  setThoughtsExpanded: (expanded: boolean) =>
    ipcRenderer.invoke(SETTINGS_IPC.setThoughtsExpanded, expanded),
  setToolViewMode: (mode: ToolViewMode) =>
    ipcRenderer.invoke(SETTINGS_IPC.setToolViewMode, mode),
  setNotificationPreferences: (preferences: NotificationPreferences) =>
    ipcRenderer.invoke(
      SETTINGS_IPC.setNotificationPreferences,
      preferences,
    ),
  setDesktopIntegration: (preferences: DesktopIntegrationPreferences) =>
    ipcRenderer.invoke(SETTINGS_IPC.setDesktopIntegration, preferences),
  setLanguage: (language: UiLanguage) =>
    ipcRenderer.invoke(SETTINGS_IPC.setLanguage, language),
  setViewedSession: (sessionId: string | null) =>
    ipcRenderer.invoke(SETTINGS_IPC.setViewedSession, sessionId),
  setRunningSubmission: (value: "queue" | "steer") =>
    ipcRenderer.invoke(SETTINGS_IPC.setRunningSubmission, value),
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
/**
 * The project and repository surface.
 *
 * Every call here is read-only; the one exception is handing an https link to the
 * OS browser, which is why the main process validates that URL again on arrival.
 */
const repo: RepoDesktopBridge = Object.freeze({
  resolveProjects: (paths: string[]) =>
    ipcRenderer.invoke(REPO_IPC.resolveProjects, paths),
  readRepository: (root: string) =>
    ipcRenderer.invoke(REPO_IPC.readRepository, root),
  readGithub: (root: string) => ipcRenderer.invoke(REPO_IPC.readGithub, root),
  listIssues: (root: string) => ipcRenderer.invoke(REPO_IPC.listIssues, root),
  getIssue: (root: string, number: number) =>
    ipcRenderer.invoke(REPO_IPC.getIssue, root, number),
  listPulls: (root: string) => ipcRenderer.invoke(REPO_IPC.listPulls, root),
  getPull: (root: string, number: number) =>
    ipcRenderer.invoke(REPO_IPC.getPull, root, number),
  openExternal: (url: string) => ipcRenderer.invoke(REPO_IPC.openExternal, url),
  revealFolder: (path: string) =>
    ipcRenderer.invoke(REPO_IPC.revealFolder, path),
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
const terminal: TerminalDesktopBridge = Object.freeze({
  start: (request: TerminalStartRequest) =>
    ipcRenderer.invoke(TERMINAL_IPC.start, request),
  write: (data: string) => {
    if (typeof data !== "string" || data.length === 0) return;
    ipcRenderer.send(TERMINAL_IPC.input, data);
  },
  resize: (cols: number, rows: number) => {
    ipcRenderer.send(TERMINAL_IPC.resize, cols, rows);
  },
  setPaused: (paused: boolean) => {
    ipcRenderer.send(TERMINAL_IPC.pause, paused);
  },
  dispose: (token: number) => ipcRenderer.invoke(TERMINAL_IPC.dispose, token),
  onOutput: (listener: (event: TerminalOutputEvent) => void) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalOutputEvent,
    ) => {
      if (!payload || typeof payload.id !== "string" || typeof payload.data !== "string")
        return;
      listener(payload);
    };
    ipcRenderer.on(TERMINAL_IPC.output, wrapped);
    return () => ipcRenderer.removeListener(TERMINAL_IPC.output, wrapped);
  },
  onExit: (listener: (event: TerminalExitEvent) => void) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalExitEvent,
    ) => {
      if (!payload || typeof payload.id !== "string" || typeof payload.exitCode !== "number")
        return;
      listener(payload);
    };
    ipcRenderer.on(TERMINAL_IPC.exit, wrapped);
    return () => ipcRenderer.removeListener(TERMINAL_IPC.exit, wrapped);
  },
});
const remote: RemoteDesktopBridge = Object.freeze({
  getState: () => ipcRenderer.invoke(REMOTE_IPC.getState),
  setEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(REMOTE_IPC.setEnabled, enabled),
  setPort: (port: number) => ipcRenderer.invoke(REMOTE_IPC.setPort, port),
  issuePairingCode: (permission: RemotePermission) =>
    ipcRenderer.invoke(REMOTE_IPC.issuePairingCode, permission),
  clearPairingCode: () => ipcRenderer.invoke(REMOTE_IPC.clearPairingCode),
  setDevicePermission: (deviceId: string, permission: RemotePermission) =>
    ipcRenderer.invoke(REMOTE_IPC.setDevicePermission, deviceId, permission),
  revokeDevice: (deviceId: string) =>
    ipcRenderer.invoke(REMOTE_IPC.revokeDevice, deviceId),
  forgetDevice: (deviceId: string) =>
    ipcRenderer.invoke(REMOTE_IPC.forgetDevice, deviceId),
  refresh: () => ipcRenderer.invoke(REMOTE_IPC.refresh),
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
    repo,
    remote,
    terminal,
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
