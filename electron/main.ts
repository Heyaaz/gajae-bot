import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerSaveBlocker,
  shell,
  systemPreferences,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  type AgentEvent,
  announcesSessionActivity,
  notificationDelivery,
  sessionActivityBody,
} from "../shared/agent-contract.js";
import { GJC_IPC } from "../shared/gjc-ipc.js";
import { GjcSdkController } from "./gjc-sdk-controller.js";
import { registerGjcIpcHandlers } from "./gjc-ipc-handlers.js";
import { DesktopEventStream } from "./desktop-event-stream.js";
import { DESKTOP_IPC, type SessionShortcut } from "../shared/settings-ipc.js";
import { registerSettingsIpcHandlers } from "./settings-ipc-handlers.js";
import { SettingsStore, validDirectory } from "./settings-store.js";
import { SessionMetadataStore } from "./session-metadata-store.js";
import { hostText, setHostLanguage } from "./host-text.js";
import { ManagementService } from "./desktop-services.js";
import { registerDesktopServicesIpcHandlers } from "./desktop-services-ipc-handlers.js";
import { ProductivityService } from "./productivity-service.js";
import { applySearchInvalidation } from "./search-invalidation.js";
import { registerProductivityIpcHandlers } from "./productivity-ipc-handlers.js";
import { AutomationService } from "./automation-service.js";
import { registerAutomationIpcHandlers } from "./automation-ipc-handlers.js";
import {
  IpcSecurity,
  expectedTopLevelUrl,
  nativeDestructiveConfirmation,
  quickInputUrl,
  rendererLaunchConfig,
} from "./ipc-security.js";
import { AttachmentStore } from "./attachment-store.js";
import { RemoteAccessService } from "./remote/service.js";
import { registerRemoteIpcHandlers } from "./remote-ipc-handlers.js";
import { RepoService } from "./repo-service.js";
import { registerRepoIpcHandlers } from "./repo-ipc-handlers.js";
import { ParallelRunService } from "./parallel-run-service.js";
import { registerParallelIpcHandlers } from "./parallel-ipc-handlers.js";
import { PARALLEL_IPC } from "../shared/parallel-ipc.js";
import { registerTerminalIpcHandlers } from "./terminal-ipc-handlers.js";
import { attachTerminalSmoke } from "./terminal-smoke.js";
import {
  DesktopIntegration,
  type DesktopIntegrationState,
} from "./desktop-integration.js";
import { desktopStatusRenderer } from "./desktop-status.js";
import { electronStatusSurface } from "./desktop-status-surface.js";
import { AppUpdateMonitor, githubRepository } from "./app-update.js";
import { DesktopStateStore } from "./desktop-state-store.js";
import { checkEnvironment, hostEnvironmentContext } from "./environment-check.js";
import { deepLinksInArgv, sessionShortcutForDeepLink } from "./deep-link.js";
import { startDeepLinkSmoke } from "./deep-link-smoke.js";
import { imageAttachments } from "./settings-ipc-handlers.js";
import { QuickInputShortcut } from "./quick-input.js";
import { QuickInputWindow, type QuickInputHandoff } from "./quick-input-window.js";
import { quickInputProjects } from "../shared/quick-input.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const {
  developmentUrl,
  mockSmokeMode,
  gjcSmokeMode,
  smokeMode,
  terminalSmokeMode,
  deepLinkSmokeMode,
} = rendererLaunchConfig(app.isPackaged);
if (terminalSmokeMode && !process.env.GAJAE_USER_DATA_DIR?.trim()) {
  process.env.GAJAE_USER_DATA_DIR = path.join(tmpdir(), "gajae-terminal-smoke");
}
if (deepLinkSmokeMode && !process.env.GAJAE_USER_DATA_DIR?.trim()) {
  process.env.GAJAE_USER_DATA_DIR = path.join(tmpdir(), `gajae-deep-link-smoke-${process.pid}`);
}
const mockBackend =
  !app.isPackaged &&
  !developmentUrl &&
  (mockSmokeMode || terminalSmokeMode || deepLinkSmokeMode);

app.setName("Gajae");
const isolatedUserData = process.env.GAJAE_USER_DATA_DIR?.trim();
app.setPath(
  "userData",
  isolatedUserData && path.isAbsolute(isolatedUserData)
    ? path.resolve(isolatedUserData)
    : path.join(app.getPath("appData"), "Agent Control"),
);
// The lock lives in userData, so it is taken only after that path is final: an
// isolated GAJAE_USER_DATA_DIR run has its own lock. The UI smokes skip it so a
// developer's running Gajae cannot make them exit before they start.
if (!smokeMode && !terminalSmokeMode && !app.requestSingleInstanceLock()) {
  console.log("Gajae is already running; the launch was handed to it.");
  app.exit(0);
}
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "electron.icns")
  : path.join(app.getAppPath(), "src/assets/gajae-icon.png");
// nativeImage cannot decode the packaged .icns, so the menu bar image is derived
// from a PNG copy the packager places beside it.
const menuBarIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "gajae-icon-ui.png")
  : path.join(app.getAppPath(), "src/assets/gajae-icon-ui.png");
const userDataDirectory = app.getPath("userData");
// Search index, session metadata, artifacts, and automations all live under this
// directory, and Electron only creates it lazily. A first launch on a clean
// machine therefore opened SQLite against a path that did not exist yet and the
// process died before any window appeared.
mkdirSync(userDataDirectory, { recursive: true });
// User files must never be rooted in the read-only packaged app.asar. Documents
// is a real filesystem directory in both development and packaged launches.
const settingsStore = new SettingsStore(userDataDirectory, app.getPath("documents"));
const preferences = settingsStore.get();
setHostLanguage(preferences.language);
const presetOverride = process.env.AGENT_CONTROL_GJC_PRESET;
const modelPreset = presetOverride?.trim()
  ? presetOverride.trim()
  : preferences.modelPreset;
const requestedWorkspace = process.env.AGENT_CONTROL_WORKSPACE;
const workspace = validDirectory(requestedWorkspace)
  ? path.resolve(requestedWorkspace)
  : preferences.workspace;
const sessionMetadata = new SessionMetadataStore(userDataDirectory);
const attachmentStore = new AttachmentStore();
let productivityService: ProductivityService | undefined;
// Declared before the controller so the event fan-out below can reach it; the
// instance itself is created once the controller exists.
let remoteAccess: RemoteAccessService | undefined;
// Declared here because the event fan-out and window lookups below run before it exists.
let quickInput: QuickInputWindow | undefined;
// Best-of-N groups learn that an attempt finished from the same events.
let parallelRuns: ParallelRunService | undefined;
// The desktop windows read runtime events over this loopback stream now instead of an
// IPC push. Constructing it only allocates the process secret; the listener starts with
// the first window.
const desktopEvents = new DesktopEventStream((message) =>
  console.log(`desktop events: ${message}`),
);

// The most recent notification this process handed to macOS. The smoke run
// asserts against it so "the app sends the notification" is a checked fact.
let lastNotification: { body: string; at: number } | undefined;
// Each window names the session it is showing. Main uses it to suppress the
// notification for a turn the user is already watching, which window focus
// alone cannot tell: a focused window may be showing a different session.
const viewedSessions = new Map<number, string>();
// The menu bar item and the Dock badge need a ready app; events before that are
// folded into the first render.
let renderDesktopStatus: ((state: DesktopIntegrationState) => void) | undefined;
// Power management, the menu bar and the Dock follow the same events the windows
// do, so they agree with the rail about which sessions are working.
const desktopIntegration = new DesktopIntegration({
  power: powerSaveBlocker,
  preferences: preferences.desktopIntegration,
  onChange: (state) => renderDesktopStatus?.(state),
});
const desktopState = new DesktopStateStore(userDataDirectory);
const appUpdates = new AppUpdateMonitor({
  currentVersion: app.getVersion(),
  repository: githubRepository(
    (
      JSON.parse(
        readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"),
      ) as { repository?: unknown }
    ).repository,
  ),
  fetch: (url, init) => net.fetch(url, init),
  announced: {
    get: () => desktopState.get().announcedAppVersion,
    set: (version) => desktopState.update({ announcedAppVersion: version }),
  },
  notify: (update) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: `Gajae ${update.latestVersion}`,
      body: hostText("새 버전이 나왔습니다. 눌러서 릴리스 페이지를 엽니다."),
    });
    notification.on("click", () => void shell.openExternal(update.releaseUrl));
    notification.on("failed", (_event, error) => {
      console.error("App update notification failed:", error);
    });
    notification.show();
  },
});

function broadcastAgentEvent(event: AgentEvent): void {
  applySearchInvalidation(event, (sessionId) => {
    productivityService?.invalidateSearch(sessionId);
  });
  const windows = appWindows();
  // The windows on this machine read the same events from the loopback stream. Nothing
  // is pushed over IPC as well: a second delivery path is how one event becomes two.
  desktopEvents.publish(event);
  desktopIntegration.observe(event);
  // The remote devices watch the same runtime, so they see the same events the
  // desktop windows do rather than a separately polled view.
  remoteAccess?.publish(event);
  parallelRuns?.observe(event);
  if (event.type !== "session.activity") return;
  const focused = windows.some((window) => window.isFocused());
  const viewingSession = windows.some(
    (window) =>
      window.isFocused() &&
      viewedSessions.get(window.webContents.id) === event.sessionId,
  );
  if (!announcesSessionActivity(event.category, focused, viewingSession))
    return;
  // A recovered connection has no toggle of its own; it is the same incidental
  // "there is new activity" ping as a message.
  const preference =
    settingsStore.get().notificationPreferences[
      event.category === "recovered" ? "message" : event.category
    ];
  if (!preference.enabled) return;
  if (!Notification.isSupported()) return;
  const delivery = notificationDelivery(preference);
  const notification = new Notification({
    title: "Gajae",
    body: sessionActivityBody(event, settingsStore.get().language),
    silent: delivery.silent,
    ...(delivery.sound ? { sound: delivery.sound } : {}),
  });
  notification.on("click", () => {
    const window = appWindows()[0];
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  // A notification that macOS refuses to deliver is invisible to the user and
  // was previously invisible here too. Recording the outcome is what makes the
  // announcement verifiable instead of assumed.
  notification.on("failed", (_event, error) => {
    console.error("Notification delivery failed:", error);
  });
  notification.show();
  lastNotification = { body: sessionActivityBody(event, settingsStore.get().language), at: Date.now() };
}

/**
 * The session windows, without the quick input window.
 *
 * That one is hidden rather than closed, so "the first window" or "no window left"
 * would otherwise count it.
 */
function appWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (window) => !quickInput?.owns(window),
  );
}

/** The focused session window, else the first one, else a new one. */
function sessionWindow(): BrowserWindow {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && !quickInput?.owns(focused)) return focused;
  return appWindows()[0] ?? createWindow();
}

// gajae:// links wait here until a window has loaded: macOS delivers the link of a
// cold launch before the app is ready, and with every window closed it arrives
// while there is none.
const pendingDeepLinks: SessionShortcut[] = [];
const loadedRenderers = new WeakSet<WebContents>();

function receiveDeepLink(url: string): void {
  const shortcut = sessionShortcutForDeepLink(url, validDirectory);
  if (!shortcut) return;
  pendingDeepLinks.push(shortcut);
  deliverDeepLinks();
}

function deliverDeepLinks(): void {
  if (!pendingDeepLinks.length || !app.isReady()) return;
  const window = sessionWindow();
  revealWindow(window);
  if (!loadedRenderers.has(window.webContents)) return;
  for (const shortcut of pendingDeepLinks.splice(0))
    window.webContents.send(DESKTOP_IPC.sessionShortcut, shortcut);
}

function revealWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveDeepLink(url);
});

app.on("second-instance", (_event, argv) => {
  const links = deepLinksInArgv(argv);
  if (links.length) {
    for (const url of links) receiveDeepLink(url);
    return;
  }
  if (!app.isReady()) return;
  revealWindow(sessionWindow());
});

for (const url of deepLinksInArgv(process.argv)) receiveDeepLink(url);
if (deepLinkSmokeMode) startDeepLinkSmoke();

function sendSessionShortcut(shortcut: SessionShortcut): void {
  const focused = BrowserWindow.getFocusedWindow();
  const window =
    focused && !quickInput?.owns(focused) ? focused : appWindows()[0];
  if (!window || window.isDestroyed()) return;
  window.webContents.send(DESKTOP_IPC.sessionShortcut, shortcut);
}

// A menu bar click takes the deep-link queue: it may have to create the window,
// and the queue already waits for that window to load before sending.
function openSessionFromMenuBar(sessionId: string): void {
  pendingDeepLinks.push({ type: "open", sessionId });
  deliverDeepLinks();
}

async function loadedWindow(window: BrowserWindow): Promise<BrowserWindow> {
  // A window this call had to create has no listener yet.
  if (window.webContents.isLoading())
    await new Promise<void>((resolve) =>
      window.webContents.once("did-finish-load", () => resolve()),
    );
  return window;
}

/**
 * Opens the new-session dialog in the main window with what the quick input
 * collected. The screenshots are issued to that window the way a picked image
 * would be, so its composer sends them through the ordinary attachment path.
 */
async function handOffQuickInput(handoff: QuickInputHandoff): Promise<void> {
  const window = sessionWindow();
  revealWindow(window);
  await loadedWindow(window);
  const images = await imageAttachments(
    handoff.images,
    attachmentStore,
    window.webContents.id,
  );
  window.webContents.send(DESKTOP_IPC.sessionShortcut, {
    type: "new",
    prefill: {
      workspace: handoff.workspace,
      prompt: handoff.prompt,
      images,
    },
  } satisfies SessionShortcut);
}

function installApplicationMenu(): void {
  const sessionItems: MenuItemConstructorOptions[] = Array.from(
    { length: 9 },
    (_, index) => ({
      label: `세션 ${index + 1}`,
      accelerator: `CommandOrControl+${index + 1}`,
      click: () => sendSessionShortcut({ type: "select", index }),
    }),
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        label: "File",
        submenu: [
          {
            label: "새 세션",
            accelerator: "CommandOrControl+T",
            click: () => sendSessionShortcut({ type: "new" }),
          },
          { type: "separator" },
          { role: "close" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { label: "Session", submenu: sessionItems },
      { role: "windowMenu" },
    ]),
  );
}

const gjcController = new GjcSdkController({
  workspace,
  executable: process.env.GJC_BIN || preferences.gjcExecutable || undefined,
  modelPreset,
  permissionHandling: preferences.permissionHandling,
  sessionMetadata,
  artifactDirectory: path.join(userDataDirectory, "artifacts"),
  emit: broadcastAgentEvent,
});
export const ipcSecurity = new IpcSecurity(
  !app.isPackaged && smokeMode ? async () => true : nativeDestructiveConfirmation,
);
const unregisterGjcIpc = registerGjcIpcHandlers(gjcController, attachmentStore, ipcSecurity);
// One authorized invoke hands a window this process launched the event stream endpoint.
// It goes through the same sender verification every gjc channel uses, so a frame or
// window this process did not open cannot read the token.
const unregisterEventStreamIpc = (() => {
  ipcMain.handle(
    GJC_IPC.eventStream,
    ipcSecurity.guarded((event: Electron.IpcMainInvokeEvent) =>
      desktopEvents.descriptorFor(`window:${event.sender.id}`),
    ),
  );
  return () => ipcMain.removeHandler(GJC_IPC.eventStream);
})();
const desktopManagement = new ManagementService(
  process.env.GJC_BIN || preferences.gjcExecutable || "gjc",
);
const automationExecutable =
  process.env.GJC_BIN ||
  preferences.gjcExecutable ||
  path.join(homedir(), ".bun/bin/gjc");
const automationService = new AutomationService({
  directory: path.join(userDataDirectory, "automations"),
  launchAgentsDirectory: path.join(homedir(), "Library/LaunchAgents"),
  electronPath: process.execPath,
  workerPath: path.join(
    app.getAppPath(),
    "dist-electron/electron/automation-worker.js",
  ),
  gjcExecutable: path.resolve(automationExecutable),
  launchctl: async (args) => {
    await new Promise<void>((resolve, reject) =>
      execFile("/bin/launchctl", args, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  },
});
quickInput = new QuickInputWindow({
  url: quickInputUrl(developmentUrl, app.getAppPath()),
  preload: path.join(currentDirectory, "preload.cjs"),
  security: new IpcSecurity(),
  captureDirectory: path.join(userDataDirectory, "quick-input-captures"),
  screenAccess: () => systemPreferences.getMediaAccessStatus("screen"),
  projects: () =>
    quickInputProjects(
      desktopIntegration.state().sessions,
      settingsStore.get().workspace,
    ),
  onSubmit: handOffQuickInput,
});
const quickInputShortcut = new QuickInputShortcut(globalShortcut, () =>
  quickInput?.toggle(),
);
const unregisterSettingsIpc = registerSettingsIpcHandlers(
  settingsStore,
  attachmentStore,
  ipcSecurity,
  async (updated) => {
    desktopManagement.setExecutable(
      process.env.GJC_BIN || updated.gjcExecutable || "gjc",
    );
    await automationService.setGjcExecutable(
      path.resolve(
        process.env.GJC_BIN ||
          updated.gjcExecutable ||
          path.join(homedir(), ".bun/bin/gjc"),
      ),
    );
    return gjcController.reconfigure(updated);
  },
  async () => {
    await gjcController.reconnect();
  },
  (senderId, sessionId) => {
    if (sessionId === null) viewedSessions.delete(senderId);
    else viewedSessions.set(senderId, sessionId);
  },
  (updated) => {
    desktopIntegration.setPreferences(updated);
    quickInputShortcut.apply(updated.quickInputShortcut);
  },
  appUpdates,
  {
    async check() {
      const current = settingsStore.get();
      const report = await checkEnvironment(
        hostEnvironmentContext({
          // The same overrides the runtime controller starts with.
          gjcExecutable: process.env.GJC_BIN || current.gjcExecutable || undefined,
          modelPreset:
            process.env.AGENT_CONTROL_GJC_PRESET?.trim() || current.modelPreset,
        }),
      );
      if (report.ready && !desktopState.get().environmentReady)
        desktopState.update({ environmentReady: true });
      return report;
    },
    // A scripted smoke drives the shell itself; a launch modal over it would be
    // in the way of what it checks, and it is nobody's first run.
    due: () =>
      !smokeMode &&
      !terminalSmokeMode &&
      !deepLinkSmokeMode &&
      !desktopState.get().environmentReady,
  },
  quickInputShortcut,
  // The menu bar is drawn before the window resolves the language, and redraws
  // otherwise only on a session change.
  () => renderDesktopStatus?.(desktopIntegration.state()),
);
const unregisterDesktopServicesIpc =
  registerDesktopServicesIpcHandlers(desktopManagement, ipcSecurity);
productivityService = new ProductivityService(
  gjcController,
  path.join(userDataDirectory, "productivity.sqlite"),
);
const unregisterProductivityIpc =
  registerProductivityIpcHandlers(productivityService, ipcSecurity);
const unregisterAutomationIpc =
  registerAutomationIpcHandlers(automationService, ipcSecurity);
remoteAccess = new RemoteAccessService({
  userDataDirectory,
  webRoot: path.join(app.getAppPath(), "dist/web"),
  version: app.getVersion(),
  workspace: () => workspace,
  host: gjcController,
  log: (message) => console.log(`remote access: ${message}`),
});
const unregisterRemoteIpc = registerRemoteIpcHandlers(remoteAccess, ipcSecurity);
// The repository screen reads Git and GitHub on demand. `gh` is resolved the way the
// CLI itself would be, with GJC_BIN's precedent for a packaged app that has to name
// an absolute path.
const repoService = new RepoService({
  ghExecutable: process.env.GAJA_GH_BIN || undefined,
});
const unregisterRepoIpc = registerRepoIpcHandlers(repoService, ipcSecurity);
parallelRuns = new ParallelRunService({
  store: sessionMetadata,
  host: gjcController,
  notify: (groups) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(PARALLEL_IPC.changed, groups);
  },
});
void gjcController
  .listSessions()
  .then((sessions) => parallelRuns?.restore(sessions))
  .catch(() => undefined);
const unregisterParallelIpc = registerParallelIpcHandlers(parallelRuns, ipcSecurity);
const terminalIpc = registerTerminalIpcHandlers(ipcSecurity);

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 540,
    backgroundColor: "#09090a",
    show: !smokeMode,
    title: "Gajae",
    icon: appIconPath,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const expectedUrl = expectedTopLevelUrl(
    developmentUrl,
    app.getAppPath(),
    mockBackend,
  );
  terminalIpc.bindWindow(window);
  ipcSecurity.register(window, expectedUrl);
  // Bind this window to the stream before its document can load, so an event published
  // while it is still loading is replayed to its preload instead of being lost.
  void desktopEvents
    .start(`window:${window.webContents.id}`)
    .catch((error) =>
      console.error("Desktop event stream failed to start", error),
    );
  const senderId = window.webContents.id;
  attachmentStore.activateSender(senderId);
  window.webContents.once("destroyed", () =>
    attachmentStore.revokeSender(senderId),
  );

  window.webContents.on("did-finish-load", () => {
    loadedRenderers.add(window.webContents);
    deliverDeepLinks();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    // Escape is deliberately not forwarded from here. This handler runs before the
    // renderer sees the key and cannot tell a rename editor or a dialog field from
    // the transcript, so re-sending every Escape as an abort cancelled runs the user
    // was still typing into. The renderer owns the key instead: its DOM handler checks
    // the target and the open surfaces before cancelling. Explicit aborts still use
    // DESKTOP_IPC.abortRun.
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (url !== expectedUrl) event.preventDefault();
  });

  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription) => {
      console.error(
        `Renderer failed to load (${errorCode}): ${errorDescription}`,
      );
      if (smokeMode) app.exit(1);
    },
  );

  if (smokeMode) {
    const smokeTimeout = setTimeout(
      () => {
        console.error("Renderer smoke test timed out");
        app.exit(1);
      },
      // The renderer sequence alone spends over 11s in deliberate waits (IME
      // commits, streaming, queue release), so a 10s budget failed on timing
      // rather than on any assertion.
      gjcSmokeMode ? 60_000 : 30_000,
    );

    window.webContents.once("did-finish-load", async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const artifactDirectory = path.join(
          app.isPackaged ? userDataDirectory : app.getAppPath(),
          "artifacts",
        );
        await mkdir(artifactDirectory, { recursive: true });
        if (mockSmokeMode) {
          await window.webContents.executeJavaScript(
            "document.querySelector('.session-row')?.click()",
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
          window.webContents.focus();
          window.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: "Tab",
            modifiers: ["shift"],
          });
          window.webContents.sendInputEvent({
            type: "keyUp",
            keyCode: "Tab",
            modifiers: ["shift"],
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (gjcSmokeMode) {
          const report = await window.webContents.executeJavaScript(`
            (async () => {
              const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
              const deadline = Date.now() + 45_000;
              while (Date.now() < deadline) {
                const connection = document.querySelector('.profile-row small');
                const sessions = document.querySelectorAll('.session-row');
                const chatIdentity = document.querySelector('.chat-identity');
                const composer = document.querySelector('.composer textarea');
                if (connection?.textContent?.includes('연결됨') && sessions.length > 0 && chatIdentity && composer) {
                  let customProfiles = false;
                  let builtInProfiles = false;
                  let modelOptionMarked = false;
                  let fastIndicator = false;
                  let fastIndicatorCleared = false;
                  let modelStatus = null;
                  // Only the session this smoke created may be driven. Clicking an
                  // arbitrary row attaches to work someone else owns, and the model
                  // picker only needs one controllable session anyway: walking the
                  // sidebar made this smoke read -- and mutate -- whatever the machine
                  // happened to have running.
                  let probeSessionId = null;
                  try {
                    const probe = await window.agentControlDesktop.gjc.createSession({
                      runtime: 'gjc',
                      title: 'Gajae smoke model probe',
                      workspace: document.querySelector('.composer-context')?.title || undefined,
                      isolation: 'workspace',
                    });
                    probeSessionId = probe.id;
                    await wait(1500);
                  } catch {
                    throw new Error('Live GJC smoke could not create its own probe session');
                  }
                  const probeRow = Array.from(document.querySelectorAll('.session-row')).find((row) => row.textContent?.includes('Gajae smoke model probe'));
                  if (!probeRow) throw new Error('Live GJC smoke probe session did not appear in the sidebar');
                  {
                    probeRow.click();
                    await wait(700);
                    modelStatus = document.querySelector('.composer-model > button');
                    if (modelStatus) {
                      modelStatus.click();
                      const profileDeadline = Date.now() + 3_000;
                      while (Date.now() < profileDeadline) {
                        const pickerText = document.querySelector('.config-option-menu--model')?.textContent ?? '';
                        customProfiles = pickerText.includes('Custom profiles');
                        builtInProfiles = pickerText.includes('Built-in profiles');
                        modelOptionMarked = Boolean(document.querySelector('.config-option-menu--model .is-current'));
                        // gjc/0.18.11 reports every profile row with source
                        // "configured" (measured: 70 configured, 0 builtin), so the
                        // built-in group is not something this smoke may require.
                        // What must hold is that the picker classified rows into a
                        // group and marked the session's current model inside it.
                        if ((customProfiles || builtInProfiles) && modelOptionMarked) break;
                        await wait(100);
                      }
                      modelStatus.click();
                    }
                    if ((customProfiles || builtInProfiles) && modelOptionMarked) {
                      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                      if (!valueSetter) throw new Error('Live GJC composer value setter is unavailable');
                      valueSetter.call(composer, '/fast on');
                      composer.dispatchEvent(new Event('input', { bubbles: true }));
                      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                      const fastDeadline = Date.now() + 5_000;
                      while (Date.now() < fastDeadline) {
                        const indicator = document.querySelector('.composer-model > button .composer-fast-mode');
                        if (indicator?.textContent?.trim() === 'Fast' && indicator.querySelector('svg')) {
                          fastIndicator = true;
                          break;
                        }
                        await wait(100);
                      }
                      if (!fastIndicator) throw new Error('Live /fast on did not render the lightning indicator');
                      valueSetter.call(composer, '/fast off');
                      composer.dispatchEvent(new Event('input', { bubbles: true }));
                      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                      const clearDeadline = Date.now() + 5_000;
                      while (Date.now() < clearDeadline) {
                        if (!document.querySelector('.composer-fast-mode')) {
                          fastIndicatorCleared = true;
                          break;
                        }
                        await wait(100);
                      }
                      if (!fastIndicatorCleared) throw new Error('Live /fast off did not clear the lightning indicator');
                    }
                  }
                  if (probeSessionId) {
                    try {
                      await window.agentControlDesktop.gjc.deleteSession(probeSessionId);
                    } catch {
                      // Leave cleanup to the operator when the probe session cannot be removed.
                    }
                  }
                  if (!modelStatus || !(customProfiles || builtInProfiles) || !modelOptionMarked) throw new Error('Live GJC probe session did not expose classified model profiles');
                  return {
                    shell: Boolean(document.querySelector('.app-shell')),
                    desktopBridge: Boolean(window.agentControlDesktop),
                    gjcBridge: Boolean(window.agentControlDesktop?.gjc),
                    connected: connection.textContent?.includes('연결됨') ?? false,
                    connectionLabel: connection.textContent?.trim() ?? '',
                    sessions: sessions.length,
                    headerLabelsRemoved: !document.querySelector('.runtime-badge, .model-badge'),
                    inspectorControl: Boolean(document.querySelector('button[title="세션 정보"]')),
                    connectionChipRemoved: !document.querySelector('.connection-pill'),
                    composer: true,
                    customProfiles,
                    builtInProfiles,
                    fastIndicator,
                    fastIndicatorCleared,
                  };
                }
                await wait(250);
              }
              throw new Error('Live GJC renderer did not become ready');
            })()
          `);
          const image = await window.webContents.capturePage();
          await writeFile(
            path.join(artifactDirectory, "gjc-ui-smoke.png"),
            image.toPNG(),
          );
          // The point of the desktop app is that a finished turn is announced by
          // it, so the live run records whether this process actually handed a
          // completion notification to macOS. The mock smoke cannot check this:
          // its backend runs in the renderer and never reaches the main process.
          await writeFile(
            path.join(artifactDirectory, "gjc-ui-smoke-report.json"),
            `${JSON.stringify(
              { ...report, announcedTurn: lastNotification?.body ?? null },
              null,
              2,
            )}\n`,
          );
          clearTimeout(smokeTimeout);
          app.exit(0);
          return;
        }
        const image = await window.webContents.capturePage();
        await writeFile(
          path.join(artifactDirectory, "ui-smoke.png"),
          image.toPNG(),
        );
        const report = await window.webContents.executeJavaScript(`
          (async () => {
            const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
            const assert = (condition, message) => {
              if (!condition) {
                document.body.dataset.smokeFailure = message;
                throw new Error(message);
              }
            };
            const buttonWithText = (text) => Array.from(document.querySelectorAll('button'))
              .find((button) => button.textContent?.trim().includes(text));

            assert(document.querySelector('.app-shell'), 'Application shell did not mount');
            assert(document.querySelectorAll('.session-row').length === 4, 'Mock sessions did not render');
            assert(!document.querySelector('.session-row .session-avatar'), 'Session profile icons still render in the list');
            document.querySelector('.session-row')?.click();
            await wait(100);
            assert(document.querySelector('.composer textarea'), 'Composer did not render');
            const toolCardCount = document.querySelectorAll('.tool-card').length;
            assert(toolCardCount === 5, 'Tool activity cards did not render: ' + toolCardCount);
            assert(document.querySelector('.tool-run .tool-run-entry + .tool-run-entry'), 'Consecutive tool calls did not collapse into one run block');
            const diffSummary = document.querySelector('.tool-diff-summary');
            assert(diffSummary, 'Edit diff summary did not render');
            // A single-file edit is the common case and opens by default; one click
            // must still collapse it and another must bring it back.
            assert(document.querySelector('.tool-diff-body'), 'Single-file edit diff did not open by default');
            assert(diffSummary.textContent?.includes('+1') && diffSummary.textContent?.includes('-1'), 'Diff summary did not report added/removed counts: ' + diffSummary.textContent);
            assert(document.querySelector('.diff-line--added'), 'Expanded diff did not mark added lines');
            assert(document.querySelector('.diff-line--removed'), 'Expanded diff did not mark removed lines');
            diffSummary.click();
            await wait(60);
            assert(!document.querySelector('.tool-diff-body'), 'Diff summary did not collapse the diff');
            diffSummary.click();
            await wait(60);
            assert(document.querySelector('.tool-diff-body'), 'Diff summary did not reopen the diff');
            assert(document.querySelector('img.tool-image'), 'Image read did not render an inline image');
            assert(document.querySelector('.tool-output-preview'), 'Compact tool output preview did not render');
            assert(document.querySelector('.tool-expand'), 'Expandable tool output action did not render');
            assert(!document.body.textContent?.includes('build output row-01'), 'Earlier tool output lines were not collapsed');
            assert(document.querySelector('.thought-card'), 'Reasoning activity did not render');
            assert(document.querySelector('.plan-card'), 'Plan activity did not render');
            assert(document.querySelector('.markdown-body h3'), 'Markdown heading did not render');
            assert(document.querySelector('.markdown-body table'), 'GitHub-flavored Markdown table did not render');
            assert(document.querySelector('.message-author')?.textContent?.includes('Gajae'), 'Assistant branding did not change to Gajae');
            assert(document.querySelector('.assistant-mark img'), 'Gajae assistant icon did not render');
            assert(!document.querySelector('.runtime-badge, .model-badge'), 'Removed header labels still render');
            const inspectorControl = document.querySelector('button[title="세션 정보"]');
            assert(inspectorControl, 'Session inspector control did not render');
            inspectorControl.click();
            await wait(50);
            assert(document.querySelector('.inspector'), 'Session inspector did not open');
            assert(document.querySelector('.subagent-card')?.textContent?.includes('executor'), 'Sub-agent status did not render in the inspector');
            const sessionIdChip = document.querySelector('.inspector-session-id code');
            assert(sessionIdChip?.textContent?.trim(), 'Inspector did not render the session id');
            // An attached session has nothing to recover, so the resume action stays hidden.
            assert(!document.querySelector('.inspector-resume'), 'Resume action rendered for an already attached session');
            assert(!document.querySelector('.inspector')?.textContent?.includes('소유권:'), 'Removed session ownership details still render');
            assert(!document.querySelector('.inspector')?.textContent?.includes('workspace:'), 'Removed workspace details still render');
            assert(!document.querySelector('.inspector')?.textContent?.includes('MCP:'), 'Removed runtime details still render');
            assert(!document.querySelector('.workflow-section'), 'Removed workflow section still renders in the inspector');
            assert(!document.querySelector('.inspector')?.textContent?.includes('GJC:'), 'Removed GJC version line still renders in the inspector');
            // A session a terminal holds is a dead end until it is attached again,
            // so the inspector has to offer the recovery and it has to work.
            const selectedBefore = document.querySelector('.session-row.is-selected');
            assert(selectedBefore, 'No session row was selected before the resume check');
            // Row text carries live status, so it changes under us. The session
            // title is the stable part of the row.
            const selectedTitle = selectedBefore.querySelector('strong')?.textContent?.trim();
            assert(selectedTitle, 'Selected session row had no title');
            const originalTranscript = document.querySelector('.transcript');
            assert(originalTranscript && originalTranscript.scrollHeight > originalTranscript.clientHeight, 'Original session transcript is not scrollable');
            originalTranscript.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
            originalTranscript.scrollTop = 0;
            originalTranscript.dispatchEvent(new Event('scroll', { bubbles: true }));
            await wait(80);
            const stuckRow = Array.from(document.querySelectorAll('.session-row')).find((node) => node.textContent?.includes('M1 Air box health'));
            assert(stuckRow, 'Terminal-only session row did not render');
            stuckRow.click();
            await wait(120);
            const resumeAction = document.querySelector('.inspector-resume');
            assert(resumeAction, 'Resume action did not render for a terminal-only session');
            resumeAction.click();
            await wait(250);
            assert(!document.querySelector('.inspector-resume'), 'Resume did not attach the terminal-only session');
            // Every later check describes the session under test, so the selection
            // these checks moved has to be handed back.
            const restoreSelection = async () => {
              const row = Array.from(document.querySelectorAll('.session-row')).find((node) => node.querySelector('strong')?.textContent?.trim() === selectedTitle);
              assert(row, 'Original session row disappeared: ' + selectedTitle);
              row.click();
              await wait(900);
            };
            await restoreSelection();
            const restoredTranscript = document.querySelector('.transcript');
            const restoredLastSlot = restoredTranscript?.querySelector('.transcript-slot[data-last="true"]');
            assert(restoredTranscript && restoredLastSlot, 'Restored session did not render its newest transcript block');
            const restoredGap = restoredTranscript.scrollHeight - restoredTranscript.scrollTop - restoredTranscript.clientHeight;
            const restoredRect = restoredTranscript.getBoundingClientRect();
            const restoredLastRect = restoredLastSlot.getBoundingClientRect();
            assert(restoredGap <= 4, 'Restored session opened away from its newest message: ' + restoredGap);
            assert(restoredLastRect.top < restoredRect.bottom && restoredLastRect.bottom <= restoredRect.bottom + 2, 'Restored session newest message is outside the viewport');
            document.querySelector('.inspector > header .icon-button')?.click();
            assert(!document.querySelector('.connection-pill'), 'Bottom-right connection chip still renders');
            assert(typeof window.agentControlDesktop?.settings.isNativeFile === 'function', 'Native file identity bridge did not render');
            assert(typeof window.agentControlDesktop?.settings.prepareImages === 'function', 'Opaque image preparation bridge did not render');
            assert(typeof window.agentControlDesktop?.settings.prepareFiles === 'function', 'Opaque file preparation bridge did not render');
            assert(typeof window.agentControlDesktop?.settings.discardAttachments === 'function', 'Attachment discard bridge did not render');
            assert(window.agentControlDesktop?.settings.pathForFile === undefined, 'Renderer still exposes native file paths');
            const attachmentButton = document.querySelector('button[title="이미지 첨부"]');
            assert(attachmentButton, 'Image attachment action did not render');
            assert(document.querySelector('button[title="파일 첨부"]'), 'Text file attachment action did not render');
            await wait(100);
            assert(document.querySelector('.composer-model'), 'Active model control did not render');
            assert(parseFloat(getComputedStyle(document.querySelector('.composer-context')).fontSize) <= 10, 'Workspace control text is still oversized');
            assert(document.querySelector('.composer-model button')?.textContent?.includes('GPT-5.6 Sol'), 'Resolved profile default model did not render');
            assert(document.querySelector('.composer-model button > span')?.textContent?.trim() === 'high', 'Native Electron Shift-Tab did not cycle reasoning effort');
            assert(document.querySelector('.chat-branch')?.textContent?.trim() === 'main', 'Current session Git branch did not render');
            assert(typeof window.agentControlDesktop?.productivity?.searchTranscripts === 'function', 'Productivity bridge did not render');
            assert(typeof window.agentControlDesktop?.automations?.list === 'function', 'Automation bridge did not render');
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
            await wait(50);
            assert(document.querySelector('.global-search-dialog'), 'Global transcript search did not open');
            document.querySelector('.global-search-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            await wait(50);
            assert(!document.querySelector('.global-search-dialog'), 'Global transcript search did not close');
            assert(document.querySelector('.workspace-rename-button'), 'Editable workspace identity control did not render');
            assert(document.querySelector('.session-context-usage')?.textContent?.trim() === '22.2%', 'Session context usage did not render in the sidebar');

            const commandTextarea = document.querySelector('.composer textarea');
            const commandValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            assert(commandTextarea && commandValueSetter, 'Composer command input is unavailable');
            commandValueSetter.call(commandTextarea, '/');
            commandTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(100);
            assert(document.querySelector('.command-palette'), 'Slash command palette did not render');
            assert(document.querySelectorAll('.command-palette > button').length > 8, 'Slash command palette still truncates runtime commands');
            assert(document.querySelector('.command-palette button[aria-label^="/skill:deep-interview"]'), 'GJC skills did not appear in command palette');
            assert(document.querySelector('.command-palette button[aria-label^="/skill:autoresearch"]'), 'Commands after the old eight-entry cap did not appear');
            assert(document.body.textContent?.includes('/model'), 'Model command did not appear in command palette');
            assert(document.body.textContent?.includes('/compact'), 'Compact command did not appear in command palette');
            assert(document.body.textContent?.includes('/new'), 'New-session command did not appear in command palette');
            assert(document.body.textContent?.includes('/steer'), 'Steer command did not appear in command palette');
            assert(document.body.textContent?.includes('/abort'), 'Abort command did not appear in command palette');
            for (let index = 0; index < 10; index += 1) {
              commandTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
              await wait(10);
            }
            const keyboardPalette = document.querySelector('.command-palette');
            const keyboardSelection = keyboardPalette?.querySelector('.is-selected');
            assert(keyboardPalette && keyboardSelection, 'Arrow-key command selection did not move');
            const paletteRect = keyboardPalette.getBoundingClientRect();
            const selectionRect = keyboardSelection.getBoundingClientRect();
            assert(keyboardPalette.scrollTop > 0, 'Arrow-key command navigation did not scroll the palette');
            assert(selectionRect.top >= paletteRect.top && selectionRect.bottom <= paletteRect.bottom, 'Arrow-key selection moved outside the visible palette');
            const contextCommand = Array.from(document.querySelectorAll('.command-palette button')).find((button) => button.textContent?.includes('/context'));
            assert(contextCommand, 'No-hint SDK command did not render');
            contextCommand.click();
            await wait(50);
            assert(!document.querySelector('.command-palette'), 'No-hint SDK command selection did not submit');
            assert(commandTextarea.value === '', 'No-hint SDK command remained stuck in the composer');
            await wait(1800);
            commandValueSetter.call(commandTextarea, '/fast on');
            commandTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            commandTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            await wait(1800);
            const fastModeIndicator = document.querySelector('.composer-model > button .composer-fast-mode');
            assert(fastModeIndicator, 'Fast mode indicator did not appear after /fast on');
            assert(fastModeIndicator.textContent?.trim() === 'Fast', 'Fast mode indicator label is incorrect');
            assert(fastModeIndicator.querySelector('svg'), 'Fast mode indicator has no lightning icon');
            assert(fastModeIndicator.getBoundingClientRect().width > 0, 'Fast mode indicator is not visible');
            const fastStatusParts = Array.from(fastModeIndicator.closest('button')?.querySelectorAll(':scope > span') ?? []).map((part) => part.textContent?.trim());
            assert(fastStatusParts.at(-1) === 'Fast', 'Fast mode indicator is not the final composer status item');
            assert(!document.querySelector('.chat-header .chat-fast-mode'), 'Fast mode indicator still appears in the chat header');
            commandValueSetter.call(commandTextarea, '/fast off');
            commandTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            commandTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            await wait(1800);
            assert(!document.querySelector('.composer-fast-mode'), 'Fast mode indicator remained after /fast off');
            commandValueSetter.call(commandTextarea, '/compact');
            commandTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(50);
            Array.from(document.querySelectorAll('.command-palette button')).find((button) => button.textContent?.includes('/compact'))?.click();
            await wait(100);
            assert(document.querySelector('.session-context-usage')?.textContent?.trim() === '8.4%', 'Compact command did not update session context usage');
            commandValueSetter.call(commandTextarea, '/model');
            commandTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(50);
            Array.from(document.querySelectorAll('.command-palette button')).find((button) => button.textContent?.includes('/model'))?.click();
            await wait(50);
            assert(document.querySelector('.config-option-menu--model'), 'Model command did not open the custom model picker');
            assert(!document.querySelector('.config-option-menu--model select'), 'Model picker fell back to a native select');
            assert(document.body.textContent?.includes('Custom profiles'), 'Custom model profile group did not render');
            assert(document.body.textContent?.includes('Built-in profiles'), 'Built-in model profile group did not render');
            document.querySelector('.config-option-menu--model .is-current')?.click();
            commandValueSetter.call(commandTextarea, '');
            commandTextarea.dispatchEvent(new Event('input', { bubbles: true }));

            commandTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
            await wait(100);
            assert(document.querySelector('.composer-model button > span')?.textContent?.trim() === 'xhigh', 'Shift-Tab did not cycle reasoning effort');
            commandTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
            await wait(100);
            assert(document.querySelector('.composer-model button > span')?.textContent?.trim() === 'low', 'Shift-Tab did not wrap the model maximum effort');
            assert(!document.querySelector('button[title="세션 설정"]'), 'Removed composer session settings still render');
            commandValueSetter.call(commandTextarea, '/effort');
            commandTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(50);
            Array.from(document.querySelectorAll('.command-palette button')).find((button) => button.textContent?.includes('/effort'))?.click();
            await wait(50);
            const effortMenu = document.querySelector('.config-option-menu--effort');
            assert(effortMenu && effortMenu.getBoundingClientRect().width <= 153, 'Effort picker remains oversized');
            assert(!Array.from(effortMenu.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'max'), 'Unsupported model effort was rendered');
            effortMenu.querySelector('.is-current')?.click();

            const compactHeight = commandTextarea.getBoundingClientRect().height;
            commandValueSetter.call(commandTextarea, 'one\\ntwo\\nthree\\nfour\\nfive');
            commandTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(100);
            assert(commandTextarea.getBoundingClientRect().height > compactHeight, 'Composer textarea did not auto-grow');
            commandValueSetter.call(commandTextarea, '');
            commandTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(100);
            assert(commandTextarea.getBoundingClientRect().height <= compactHeight + 2, 'Composer textarea did not shrink after clearing');

            const droppedImage = new File([new Uint8Array([137, 80, 78, 71])], 'dropped.png', { type: 'image/png' });
            const dragEnterEvent = new Event('dragenter', { bubbles: true, cancelable: true });
            Object.defineProperty(dragEnterEvent, 'dataTransfer', { value: { files: [droppedImage], types: ['Files'] } });
            document.querySelector('.transcript')?.dispatchEvent(dragEnterEvent);
            assert(document.querySelector('.app-shell')?.classList.contains('is-dragging-files'), 'App-wide file drop target did not activate');
            const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(dropEvent, 'dataTransfer', { value: { files: [droppedImage], types: ['Files'] } });
            document.querySelector('.transcript')?.dispatchEvent(dropEvent);
            await wait(100);
            assert(document.querySelector('.composer-images img[alt="dropped.png"]'), 'Dropped image did not attach to the composer');
            document.querySelector('.composer-images button')?.click();

            document.querySelector('.composer-context')?.click();
            await wait(50);
            assert(document.querySelector('.workspace-menu'), 'Direct workspace switcher did not render');
            document.querySelector('.chat-header')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            await wait(50);
            assert(!document.querySelector('.workspace-menu'), 'Workspace switcher did not close on outside click');

            document.querySelector('button[title="변경 파일 보기"]')?.click();
            await wait(100);
            assert(document.querySelector('.diff-panel'), 'Changed-files review panel did not render');
            assert(document.querySelector('.diff-panel')?.textContent?.includes('README.md'), 'Changed file did not render');
            assert(document.querySelector('.diff-panel pre')?.textContent?.includes('+# Gajae'), 'Full diff patch did not render');
            document.querySelector('.diff-panel > header .icon-button')?.click();

            const forkTarget = document.querySelector('.session-row');
            forkTarget?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
            await wait(50);
            assert(buttonWithText('현재 상태에서 포크'), 'Latest-state session fork action did not render');
            document.querySelector('.chat-header')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            assert(document.querySelector('[data-terminal-toggle]'), 'Terminal surface toggle is missing');
            assert(typeof window.agentControlDesktop?.terminal?.start === 'function', 'Terminal bridge is missing');

            const approve = buttonWithText('이번만 허용');
            assert(approve, 'Approval action did not render');
            approve.click();
            await wait(100);
            assert(document.querySelector('.tool-status--approved'), 'Approval did not update the tool state');

            const settings = buttonWithText('설정');
            assert(settings, 'Settings action did not render');
            settings.click();
            // The dialog is a deferred chunk; give the import a beat on a cold run.
            await wait(500);
            assert(document.querySelector('[role="dialog"]'), 'Settings dialog did not open');
            assert(document.querySelectorAll('.backend-card').length === 1, 'GJC settings card did not render');
            assert(document.querySelector('.backend-logo img'), 'Gajae icon did not render in settings');
            assert(document.querySelector('input[list="gjc-model-profiles"]'), 'Custom profile field did not render');
            assert(!document.querySelector('.settings-panel select'), 'Native select still renders in settings');
            const approvalDropdown = document.querySelector('.settings-panel .dropdown-trigger');
            assert(approvalDropdown, 'Approval dropdown did not render');
            approvalDropdown.click();
            await wait(50);
            assert(document.querySelectorAll('.dropdown-menu [role="option"]').length === 3, 'Approval dropdown options did not render');
            document.querySelector('.dropdown-menu [role="option"]')?.click();
            await wait(50);
            assert(!document.querySelector('.dropdown-menu'), 'Approval dropdown did not close after selection');
            assert(buttonWithText('MCP') && buttonWithText('Skills/Plugins') && buttonWithText('Usage') && buttonWithText('Automations'), 'Management settings tabs did not render');
            buttonWithText('Automations')?.click();
            await wait(50);
            assert(document.querySelector('.automation-panel'), 'Automation settings panel did not render');
            assert(!buttonWithText('Accounts'), 'Removed Accounts settings tab still renders');
            const workspaceTab = buttonWithText('Workspace');
            assert(workspaceTab, 'Workspace settings tab did not render');
            workspaceTab.click();
            await wait(100);
            assert(document.querySelector('.workspace-card'), 'Workspace scope card did not render');
            document.querySelector('[role="dialog"] .icon-button')?.click();
            await wait(100);

            const assistantCount = document.querySelectorAll('.message--assistant').length;
            const textarea = document.querySelector('.composer textarea');
            const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            assert(textarea && valueSetter, 'Composer input is unavailable');
            textarea.focus();
            assert(getComputedStyle(textarea).outlineStyle === 'none', 'Composer rendered an internal focus divider');
            valueSetter.call(textarea, 'Desktop smoke message');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(100);
            assert(!document.querySelector('.send-button--stop'), 'A finished turn left the composer treating an idle session as running');
            assert(document.querySelectorAll('.composer-submit-actions .send-button').length === 1, 'The idle composer rendered more than one submit action');
            document.querySelector('.composer')?.requestSubmit();
            await wait(500);
            assert(document.querySelector('button[title="작업 중단 (Esc)"]'), 'Abort action did not render during an active run');
            assert(document.querySelectorAll('.composer-submit-actions .send-button').length === 1, 'The submit slot rendered send and stop at the same time during an active run');
            assert(!document.querySelector('button[title="메시지 보내기"]'), 'Send button did not become the abort button during an active run');
            valueSetter.call(textarea, '한국어 조종');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
            await wait(50);
            assert(textarea.value === '한국어 조종', 'Korean IME composition Enter submitted a partial duplicate steer');
            // An explicit queue prefix keeps this check independent of the user's
            // persisted queue/steer preference.
            valueSetter.call(textarea, '/queue focus on the regression');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(50);
            assert(document.querySelector('button[title="이어서 보내기"]'), 'Active run kept the stop button after a steer/follow-up draft was entered');
            assert(document.querySelectorAll('.composer-submit-actions .send-button').length === 1, 'The submit slot rendered send and stop at the same time');
            assert(!document.querySelector('.send-button--stop'), 'Stop button stayed visible while a draft was ready to submit');
            document.querySelector('button[title="이어서 보내기"]')?.click();
            await wait(100);
            assert(document.activeElement === textarea, 'Composer did not restore focus for the immediate second Enter action');
            assert(Array.from(document.querySelectorAll('.composer-queue-item--followUp')).some((node) => node.textContent?.includes('focus on the regression')), 'Ordinary active-run input was not held in the composer queue');
            assert(!document.querySelector('.composer-queue-item--steer'), 'Ordinary active-run input was incorrectly marked as an immediate steer');
            await wait(1_800);
            assert(document.body.textContent?.includes('Desktop smoke message'), 'User message did not append');
            assert(Array.from(document.querySelectorAll('.message--user')).filter((node) => node.textContent?.includes('Desktop smoke message')).length === 1, 'The confirmed request rendered as two user bubbles');
            // The prompt is answered, and the request held during that turn is
            // released automatically once it ends, so it is answered too.
            assert(document.querySelectorAll('.message--assistant').length > assistantCount, 'Assistant reply did not append');
            assert(!document.querySelector('.composer-queue'), 'Held request was not released when the turn ended');
            await wait(1_800);
            assert(!document.querySelector('.streaming-caret'), 'Assistant reply did not finish streaming');

            textarea.focus();
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
            await wait(50);
            assert(textarea.value === '/queue focus on the regression', 'ArrowUp did not restore the most recent prompt');
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
            await wait(50);
            assert(textarea.value === 'Desktop smoke message', 'Repeated ArrowUp did not navigate prompt history');
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            await wait(50);
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            await wait(50);
            assert(textarea.value === '', 'ArrowDown did not restore the current draft');

            valueSetter.call(textarea, 'Immediate steer base run');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('.composer')?.requestSubmit();
            await wait(100);
            // Same explicit prefix as the earlier queue check: a user preference of
            // steer must not turn this held-request assertion into an immediate send.
            valueSetter.call(textarea, '/queue 체크');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('.composer-submit-actions .send-button')?.click();
            await wait(120);
            const steerChips = () => Array.from(document.querySelectorAll('.composer-queue-item')).map((node) => node.textContent ?? '');
            assert(steerChips().some((text) => text.includes('체크')), 'Steer did not register in the composer queue: ' + steerChips().join(' | '));
            assert(document.activeElement === textarea, 'Composer lost focus after submitting a steer');
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
            await wait(200);
            assert(!document.querySelector('.composer-queue'), 'Queued steer indicator survived the flush: ' + steerChips().join(' | '));
            assert(document.body.textContent?.includes('체크'), 'Flushed steer did not reach the transcript');

            // Past sessions are unreachable from the sidebar once the broker stops
            // reporting them live, so the picker is the only way back to them.
            document.querySelector('button[title="지난 세션 이어서 진행"]')?.click();
            await wait(120);
            const resumeDialog = document.querySelector('.resume-session-dialog');
            assert(resumeDialog, 'Resume session picker did not open');
            const historyRows = document.querySelectorAll('.resume-session-list > button');
            assert(historyRows.length > 0, 'Resume picker listed no past sessions');
            assert(document.querySelector('.resume-session-meta code')?.textContent?.trim(), 'Resume picker did not show session ids');
            const resumeSearch = resumeDialog.querySelector('input');
            const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            assert(resumeSearch && inputValueSetter, 'Resume picker search is unavailable');
            inputValueSetter.call(resumeSearch, 'zzz-no-such-session');
            resumeSearch.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(60);
            assert(document.querySelectorAll('.resume-session-list > button').length === 0, 'Resume picker ignored its filter');
            inputValueSetter.call(resumeSearch, '');
            resumeSearch.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(60);
            // A long first request must not widen the row: that pushed the id/time
            // line out of the dialog and left the list scrolling sideways.
            const resumeList = document.querySelector('.resume-session-list');
            assert(resumeList.scrollWidth <= resumeList.clientWidth + 1, 'Resume picker overflowed sideways: ' + resumeList.scrollWidth + ' > ' + resumeList.clientWidth);
            const resumeRow = document.querySelector('.resume-session-list > button');
            assert(resumeRow.getBoundingClientRect().right <= resumeDialog.getBoundingClientRect().right + 1, 'Resume row escaped the dialog');
            // Choosing a session closes the picker; leaving it open hid the result.
            resumeRow.click();
            await wait(250);
            assert(!document.querySelector('.resume-session-dialog'), 'Resume picker stayed open after choosing a session');
            await restoreSelection();

            const initialSessions = document.querySelectorAll('.session-row').length;
            document.querySelector('button[title="새 Gajae 세션"]')?.click();
            await wait(100);
            assert(document.querySelector('.new-session-dialog'), 'New session project dialog did not render');
            assert(document.querySelector('.project-location-field'), 'Project location control did not render');
            assert(document.querySelector('.isolation-options')?.textContent?.includes('별도 worktree 생성'), 'Managed worktree choice did not render');
            buttonWithText('세션 만들기')?.click();
            await wait(150);
            assert(document.querySelectorAll('.session-row').length === initialSessions + 1, 'New session did not render');
            assert(document.querySelector('.empty-conversation'), 'New session did not select its empty transcript');
            assert(!document.querySelector('.prompt-suggestions'), 'Removed empty-chat suggestion buttons still render');

            // An unsent draft belongs to the session it was typed in. One composer
            // serves every session, so without parking it the text stays in the box
            // and would be sent to whichever session the user switched to.
            {
              const box = document.querySelector('.composer textarea');
              assert(box && valueSetter, 'Composer input is unavailable for the draft check');
              assert(box.value === '', 'A fresh session opened with text already in the composer: ' + box.value);
              valueSetter.call(box, '이 세션에서만 보여야 하는 초안');
              box.dispatchEvent(new Event('input', { bubbles: true }));
              await wait(60);
              const rows = Array.from(document.querySelectorAll('.session-row'));
              const drafting = rows.find((row) => row.classList.contains('is-selected'));
              const other = rows.find((row) => !row.classList.contains('is-selected'));
              assert(drafting && other, 'Need a selected and an unselected session row for the draft check');
              // Rows are matched by title because row text also carries live status,
              // which changes as sessions run.
              const draftingTitle = drafting.querySelector('strong')?.textContent?.trim();
              assert(draftingTitle, 'Drafting session row had no title');
              other.click();
              await wait(150);
              const afterSwitch = document.querySelector('.composer textarea');
              assert(afterSwitch, 'Composer disappeared after switching sessions');
              assert(afterSwitch.value === '', 'Unsent draft leaked into another session: ' + afterSwitch.value);
              const back = Array.from(document.querySelectorAll('.session-row')).find((row) => row.querySelector('strong')?.textContent?.trim() === draftingTitle);
              assert(back, 'Could not switch back to the drafting session: ' + draftingTitle);
              back.click();
              await wait(150);
              const restored = document.querySelector('.composer textarea');
              assert(restored?.value === '이 세션에서만 보여야 하는 초안', 'Draft was lost instead of parked with its session: ' + restored?.value);
              valueSetter.call(restored, '');
              restored.dispatchEvent(new Event('input', { bubbles: true }));
              await wait(60);
            }

            const createdSession = document.querySelector('.session-row.is-selected');
            assert(createdSession, 'Created session was not selected');
            createdSession.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 180, clientY: 180 }));
            await wait(100);
            const rename = buttonWithText('이름 변경');
            assert(rename, 'Session rename action did not render');
            rename.click();
            await wait(100);
            const renameInput = document.querySelector('.session-rename-input');
            const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            assert(renameInput && inputSetter, 'Session rename input did not render');
            inputSetter.call(renameInput, 'Smoke renamed session');
            renameInput.dispatchEvent(new Event('input', { bubbles: true }));
            renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await wait(150);
            assert(document.body.textContent?.includes('Smoke renamed session'), 'Session rename did not persist in UI');

            const renamedSession = document.querySelector('.session-row.is-selected');
            renamedSession.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 180, clientY: 180 }));
            await wait(100);
            const deleteAction = document.querySelector('.session-context-menu .is-danger');
            assert(deleteAction, 'Session delete action did not render');
            deleteAction.click();
            await wait(100);
            assert(document.querySelector('.confirm-dialog'), 'Delete confirmation did not render');
            document.querySelector('.confirm-dialog .button-danger')?.click();
            await wait(150);
            assert(document.querySelectorAll('.session-row').length === initialSessions, 'Deleted session remained in sidebar');

            return {
              shell: true,
              initialSessions,
              toolApproval: 'approved',
              settingsControls: true,
              liveReasoning: true,
              compactToolOutput: true,
              planProgress: true,
              slashCommands: true,
              activeModel: true,
              directWorkspaceSwitcher: true,
              readableComposerControls: true,
              editableWorkspaceIdentity: true,
              autoGrowingComposer: true,
              modelCommand: true,
              compactCommand: true,
              newCommand: true,
              steerCommand: true,
              abortCommand: true,
              activeRunControls: true,
              queuedFollowUp: true,
              escapeAbort: true,
              sidebarContextUsage: true,
              effortShortcut: true,
              nativeEffortShortcut: true,
              effortWrap: true,
              modelSpecificEffort: true,
              compactEffortControls: true,
              noComposerSessionSettings: true,
              largerInterfaceScale: true,
              gajaeBranding: true,
              koreanMode: true,
              identityIcons: true,
              iconFreeSessionList: true,
              compactWorkspaceControl: true,
              sessionWideImageDrop: true,
              directNativeImagePicker: true,
              inspectorControl: true,
              subagentStatus: true,
              connectionChipRemoved: true,
              cleanEmptyState: true,
              streamedReply: true,
              createdSession: true,
              renamedSession: true,
              deletedSession: true,
            };
          })()
        `);
        await writeFile(
          path.join(artifactDirectory, "smoke-report.json"),
          `${JSON.stringify(report, null, 2)}\n`,
        );
        clearTimeout(smokeTimeout);
        app.exit(0);
      } catch (error) {
        const diagnostic = await window.webContents
          .executeJavaScript(
            'document.body.dataset.smokeFailure || "unknown assertion"',
          )
          .catch(() => "unavailable");
        console.error(`Renderer smoke capture failed: ${diagnostic}`, error);
        app.exit(1);
      }
    });
  }

  if (!app.isPackaged && developmentUrl) {
    void window.loadURL(developmentUrl);
  } else {
    void window.loadFile(path.join(app.getAppPath(), "dist/index.html"), {
      query: mockBackend ? { backend: "mock" } : undefined,
    });
  }

  if (terminalSmokeMode) attachTerminalSmoke(window);

  return window;
}

app.whenReady().then(() => {
  void remoteAccess?.start();
  void automationService
    .initialize()
    .catch((error) =>
      console.error("Automation scheduler initialization failed", error),
    );
  installApplicationMenu();
  // Sessions the runtime reported before the first event still count as working.
  void gjcController
    .listSessions()
    .then((sessions) => desktopIntegration.seed(sessions))
    .catch((error) =>
      console.error("Desktop integration could not read sessions", error),
    );
  if (process.platform === "darwin")
    app.dock?.setIcon(nativeImage.createFromPath(appIconPath));
  renderDesktopStatus = desktopStatusRenderer(
    electronStatusSurface({
      iconPath: menuBarIconPath,
      openSession: openSessionFromMenuBar,
      openApp: () => revealWindow(sessionWindow()),
    }),
  );
  renderDesktopStatus(desktopIntegration.state());
  quickInputShortcut.apply(
    settingsStore.get().desktopIntegration.quickInputShortcut,
  );
  createWindow();
  // A development build is not a release anyone installed, so it only checks when
  // asked from settings.
  if (app.isPackaged)
    appUpdates.startAutomaticChecks(
      () => settingsStore.get().desktopIntegration.checkAppUpdates,
      { firstDelayMs: 15_000, intervalMs: 24 * 60 * 60_000 },
    );

  app.on("activate", () => {
    if (appWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || smokeMode) app.quit();
});

app.on("before-quit", () => {
  ipcSecurity.dispose();
  unregisterGjcIpc();
  unregisterSettingsIpc();
  unregisterDesktopServicesIpc();
  unregisterProductivityIpc();
  unregisterAutomationIpc();
  unregisterRemoteIpc();
  unregisterRepoIpc();
  unregisterParallelIpc();
  terminalIpc.disposeAll();
  terminalIpc.unregister();
  unregisterEventStreamIpc();
  void desktopEvents.close();
  void remoteAccess?.dispose();
  gjcController.dispose();
  desktopIntegration.dispose();
  quickInputShortcut.dispose();
  quickInput?.dispose();
  appUpdates.dispose();
  attachmentStore.dispose();
});
