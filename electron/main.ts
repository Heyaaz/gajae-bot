import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  type AgentEvent,
  announcesSessionActivity,
  sessionActivityBody,
} from "../shared/agent-contract.js";
import { GJC_IPC } from "../shared/gjc-ipc.js";
import { GjcAcpController } from "./gjc-acp-controller.js";
import { registerGjcIpcHandlers } from "./gjc-ipc-handlers.js";
import { DESKTOP_IPC, type SessionShortcut } from "../shared/settings-ipc.js";
import { registerSettingsIpcHandlers } from "./settings-ipc-handlers.js";
import { SettingsStore } from "./settings-store.js";
import { SessionMetadataStore } from "./session-metadata-store.js";
import { ManagementService } from "./desktop-services.js";
import { registerDesktopServicesIpcHandlers } from "./desktop-services-ipc-handlers.js";
import { ProductivityService } from "./productivity-service.js";
import { registerProductivityIpcHandlers } from "./productivity-ipc-handlers.js";
import { AutomationService } from "./automation-service.js";
import { registerAutomationIpcHandlers } from "./automation-ipc-handlers.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentUrl = process.env.VITE_DEV_SERVER_URL;
const mockSmokeMode = process.argv.includes("--smoke");
const gjcSmokeMode = process.argv.includes("--gjc-smoke");
const smokeMode = mockSmokeMode || gjcSmokeMode;
app.setName("Gajae");
app.setPath("userData", path.join(app.getPath("appData"), "Agent Control"));
const appIconPath = path.join(app.getAppPath(), "src/assets/gajae-icon.png");
const userDataDirectory = app.getPath("userData");
const settingsStore = new SettingsStore(userDataDirectory, app.getAppPath());
const preferences = settingsStore.get();
const presetOverride = process.env.AGENT_CONTROL_GJC_PRESET;
const modelPreset = presetOverride?.trim()
  ? presetOverride.trim()
  : preferences.modelPreset;
const workspace = path.resolve(
  process.env.AGENT_CONTROL_WORKSPACE ?? preferences.workspace,
);
const sessionMetadata = new SessionMetadataStore(userDataDirectory);
let productivityService: ProductivityService | undefined;

// The most recent notification this process handed to macOS. The smoke run
// asserts against it so "the app sends the notification" is a checked fact.
let lastNotification: { body: string; at: number } | undefined;

function broadcastAgentEvent(event: AgentEvent): void {
  if (
    event.type === "session.created" ||
    event.type === "session.updated" ||
    event.type === "session.deleted" ||
    event.type === "transcript.appended" ||
    event.type === "transcript.synced" ||
    event.type === "message.delta" ||
    event.type === "message.updated" ||
    event.type === "thought.delta" ||
    event.type === "plan.updated" ||
    event.type === "tool.updated"
  )
    productivityService?.invalidateSearch();
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed()) window.webContents.send(GJC_IPC.event, event);
  }
  if (event.type !== "session.activity") return;
  if (
    !announcesSessionActivity(
      event.category,
      windows.some((window) => window.isFocused()),
    )
  )
    return;
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: "Gajae",
    body: sessionActivityBody(event),
    silent: event.category === "message",
  });
  notification.on("click", () => {
    const window = BrowserWindow.getAllWindows()[0];
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
  lastNotification = { body: sessionActivityBody(event), at: Date.now() };
}

function sendSessionShortcut(shortcut: SessionShortcut): void {
  const window =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!window || window.isDestroyed()) return;
  window.webContents.send(DESKTOP_IPC.sessionShortcut, shortcut);
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

const gjcController = new GjcAcpController({
  workspace,
  executable: process.env.GJC_BIN || preferences.gjcExecutable || undefined,
  modelPreset,
  permissionHandling: preferences.permissionHandling,
  sessionMetadata,
  artifactDirectory: path.join(userDataDirectory, "artifacts"),
  emit: broadcastAgentEvent,
});
const unregisterGjcIpc = registerGjcIpcHandlers(gjcController);
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
const unregisterSettingsIpc = registerSettingsIpcHandlers(
  settingsStore,
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
);
const unregisterDesktopServicesIpc =
  registerDesktopServicesIpcHandlers(desktopManagement);
productivityService = new ProductivityService(
  gjcController,
  path.join(userDataDirectory, "productivity.sqlite"),
);
const unregisterProductivityIpc =
  registerProductivityIpcHandlers(productivityService);
const unregisterAutomationIpc =
  registerAutomationIpcHandlers(automationService);

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

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (
      input.key === "Tab" &&
      input.shift &&
      !input.meta &&
      !input.control &&
      !input.alt
    ) {
      event.preventDefault();
      window.webContents.send(DESKTOP_IPC.cycleEffort);
      return;
    }
    if (
      (input.key === "Escape" || input.key === "Esc") &&
      !input.meta &&
      !input.control &&
      !input.alt &&
      !input.shift
    ) {
      window.webContents.send(DESKTOP_IPC.abortRun);
    }
  });

  window.webContents.on("will-navigate", (event, url) => {
    const expectedUrl =
      developmentUrl ??
      `file://${path.join(app.getAppPath(), "dist/index.html")}`;
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
                  let modelStatus = null;
                  // A freshly created session is the only reliably attachable one: previously
                  // listed sessions may be owned by a terminal with no attachable ACP endpoint.
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
                    // Fall back to listed sessions when session creation is unavailable.
                  }
                  const orderedSessions = Array.from(document.querySelectorAll('.session-row')).sort((left, right) => Number(right.textContent?.includes('Gajae smoke model probe')) - Number(left.textContent?.includes('Gajae smoke model probe')));
                  for (const sessionRow of orderedSessions) {
                    sessionRow.click();
                    await wait(700);
                    modelStatus = document.querySelector('.composer-model > button');
                    if (!modelStatus) continue;
                    modelStatus.click();
                    const profileDeadline = Date.now() + 3_000;
                    while (Date.now() < profileDeadline) {
                      const pickerText = document.querySelector('.config-option-menu--model')?.textContent ?? '';
                      customProfiles = pickerText.includes('Custom profiles');
                      builtInProfiles = pickerText.includes('Built-in profiles');
                      if (customProfiles && builtInProfiles) break;
                      await wait(100);
                    }
                    modelStatus.click();
                    if (customProfiles && builtInProfiles) break;
                  }
                  if (probeSessionId) {
                    try {
                      await window.agentControlDesktop.gjc.deleteSession(probeSessionId);
                    } catch {
                      // Leave cleanup to the operator when the probe session cannot be removed.
                    }
                  }
                  if (!modelStatus || !customProfiles || !builtInProfiles) throw new Error('No attachable GJC session exposed classified model profiles');
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
            assert(!document.querySelector('.tool-diff-body'), 'Edit diff opened before it was expanded');
            assert(diffSummary.textContent?.includes('+1') && diffSummary.textContent?.includes('-1'), 'Diff summary did not report added/removed counts: ' + diffSummary.textContent);
            diffSummary.click();
            await wait(60);
            assert(document.querySelector('.diff-line--added'), 'Expanded diff did not mark added lines');
            assert(document.querySelector('.diff-line--removed'), 'Expanded diff did not mark removed lines');
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
              await wait(120);
            };
            await restoreSelection();
            document.querySelector('.inspector > header .icon-button')?.click();
            assert(!document.querySelector('.connection-pill'), 'Bottom-right connection chip still renders');
            assert(typeof window.agentControlDesktop?.settings.pathForFile === 'function', 'Chromium file chooser bridge did not render');
            const attachmentButton = document.querySelector('button[title="이미지 첨부"]');
            assert(attachmentButton, 'Image attachment action did not render');
            assert(document.querySelector('button[title="파일 첨부"]'), 'Text file attachment action did not render');
            await wait(100);
            assert(document.querySelector('.composer-model'), 'Active model control did not render');
            assert(parseFloat(getComputedStyle(document.querySelector('.composer-context')).fontSize) <= 9, 'Workspace control text is still oversized');
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
            assert(document.body.textContent?.includes('/skill:deep-interview'), 'GJC skills did not appear in command palette');
            assert(document.body.textContent?.includes('/skill:autoresearch'), 'Commands after the old eight-entry cap did not appear');
            assert(document.body.textContent?.includes('/model'), 'Model command did not appear in command palette');
            assert(document.body.textContent?.includes('/compact'), 'Compact command did not appear in command palette');
            assert(document.body.textContent?.includes('/new'), 'New-session command did not appear in command palette');
            assert(document.body.textContent?.includes('/steer'), 'Steer command did not appear in command palette');
            assert(document.body.textContent?.includes('/abort'), 'Abort command did not appear in command palette');
            const contextCommand = Array.from(document.querySelectorAll('.command-palette button')).find((button) => button.textContent?.includes('/context'));
            assert(contextCommand, 'No-hint SDK command did not render');
            contextCommand.click();
            await wait(50);
            assert(!document.querySelector('.command-palette'), 'No-hint SDK command selection did not submit');
            assert(commandTextarea.value === '', 'No-hint SDK command remained stuck in the composer');
            await wait(1800);
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

            document.querySelector('button[title="변경 파일"]')?.click();
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
            assert(!document.querySelector('button[title="터미널"]'), 'Removed integrated terminal action still renders');
            assert(!window.agentControlDesktop?.terminal, 'Removed terminal bridge is still exposed');

            const approve = buttonWithText('이번만 허용');
            assert(approve, 'Approval action did not render');
            approve.click();
            await wait(100);
            assert(document.querySelector('.tool-status--approved'), 'Approval did not update the tool state');

            const settings = buttonWithText('설정');
            assert(settings, 'Settings action did not render');
            settings.click();
            await wait(100);
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
            valueSetter.call(textarea, 'focus on the regression');
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
            assert(textarea.value === 'focus on the regression', 'ArrowUp did not restore the most recent prompt');
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
            valueSetter.call(textarea, '체크');
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

  if (developmentUrl) {
    void window.loadURL(developmentUrl);
  } else {
    void window.loadFile(path.join(app.getAppPath(), "dist/index.html"), {
      query: mockSmokeMode ? { backend: "mock" } : undefined,
    });
  }

  return window;
}

app.whenReady().then(() => {
  void automationService
    .initialize()
    .catch((error) =>
      console.error("Automation scheduler initialization failed", error),
    );
  installApplicationMenu();
  if (process.platform === "darwin")
    app.dock?.setIcon(nativeImage.createFromPath(appIconPath));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || smokeMode) app.quit();
});

app.on("before-quit", () => {
  unregisterGjcIpc();
  unregisterSettingsIpc();
  unregisterDesktopServicesIpc();
  unregisterProductivityIpc();
  unregisterAutomationIpc();
  gjcController.dispose();
});
