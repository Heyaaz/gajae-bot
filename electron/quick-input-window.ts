import { BrowserWindow, ipcMain, nativeImage, screen, shell } from "electron";
import {
  QUICK_INPUT_IPC,
  parseQuickInputSubmission,
  type QuickInputState,
} from "../shared/quick-input.js";
import type { IpcSecurity } from "./ipc-security.js";
import { captureScreen, removeCaptures, type ScreenAccess } from "./quick-input.js";

/** What the quick input hands to the main window: nothing is sent from here. */
export interface QuickInputHandoff {
  workspace: string;
  prompt: string;
  /** Screenshot files main took for this submission. */
  images: string[];
}

export interface QuickInputWindowOptions {
  /** The exact top-level URL the window loads, which its sender check compares against. */
  url: string;
  preload: string;
  /** A guard of its own, so this window reaches only the quick input channels. */
  security: IpcSecurity;
  captureDirectory: string;
  screenAccess(): ScreenAccess;
  projects(): string[];
  onSubmit(handoff: QuickInputHandoff): Promise<void>;
}

const SCREEN_RECORDING_SETTINGS =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

function downscalePng(png: Buffer, factor: number): Buffer {
  const image = nativeImage.createFromBuffer(png);
  const { width } = image.getSize();
  return image
    .resize({ width: Math.max(1, Math.round(width * factor)), quality: "best" })
    .toPNG();
}

/**
 * The small window the global shortcut opens over whatever app is in front.
 *
 * It is created once and hidden rather than closed, so the second press opens it
 * at once and an unsent draft survives a click elsewhere.
 */
export class QuickInputWindow {
  private window: BrowserWindow | undefined;
  /** Capture id to file. Only files this process took can be attached from here. */
  private readonly captures = new Map<string, string>();
  private capturing = false;

  constructor(private readonly options: QuickInputWindowOptions) {
    const { security } = options;
    removeCaptures(options.captureDirectory);
    ipcMain.handle(
      QUICK_INPUT_IPC.state,
      security.guarded((): QuickInputState => ({ projects: options.projects() })),
    );
    ipcMain.handle(
      QUICK_INPUT_IPC.capture,
      security.guarded(() => this.capture()),
    );
    ipcMain.handle(
      QUICK_INPUT_IPC.submit,
      security.guarded((_event, value: unknown) => this.submit(value)),
    );
    ipcMain.handle(
      QUICK_INPUT_IPC.dismiss,
      security.guarded(() => this.window?.hide()),
    );
    ipcMain.handle(
      QUICK_INPUT_IPC.openScreenRecordingSettings,
      security.guarded(() => shell.openExternal(SCREEN_RECORDING_SETTINGS)),
    );
  }

  owns(window: BrowserWindow): boolean {
    return window === this.window;
  }

  toggle(): void {
    const window = this.window;
    if (window && !window.isDestroyed() && window.isVisible() && window.isFocused())
      window.hide();
    else this.show();
  }

  show(): void {
    const window = this.ensureWindow();
    if (window.webContents.isLoading())
      window.webContents.once("did-finish-load", () => this.reveal(window));
    else this.reveal(window);
  }

  dispose(): void {
    for (const channel of Object.values(QUICK_INPUT_IPC))
      ipcMain.removeHandler(channel);
    this.options.security.dispose();
    this.captures.clear();
    removeCaptures(this.options.captureDirectory);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
  }

  private reveal(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    // Open on the display the user is working on, where a launcher is expected.
    const { workArea } = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    const [width] = window.getSize();
    window.setPosition(
      Math.round(workArea.x + (workArea.width - width) / 2),
      Math.round(workArea.y + workArea.height * 0.22),
    );
    window.show();
    window.focus();
    window.webContents.send(QUICK_INPUT_IPC.shown);
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BrowserWindow({
      width: 640,
      height: 236,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // A non-activating panel takes the keyboard without bringing Gajae's main
      // window in front of the app the user was in, and floats over full screen.
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      backgroundColor: "#151517",
      title: "Gajae",
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    if (process.platform === "darwin") {
      // Without these the panel stays on the Space it was created in and cannot
      // sit over a full-screen app, so the shortcut would switch Spaces.
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.setAlwaysOnTop(true, "screen-saver");
    }
    this.options.security.register(window, this.options.url);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("blur", () => {
      // The capture overlay takes focus while the user picks a region.
      if (!this.capturing) window.hide();
    });
    window.on("closed", () => {
      if (this.window === window) this.window = undefined;
    });
    void window.loadURL(this.options.url);
    this.window = window;
    return window;
  }

  private async capture() {
    if (this.capturing) throw new Error("A capture is already in progress");
    this.capturing = true;
    // Hidden so the user can capture what is underneath it.
    this.window?.hide();
    try {
      const { file, ...result } = await captureScreen({
        directory: this.options.captureDirectory,
        screenAccess: this.options.screenAccess,
        downscale: downscalePng,
      });
      if (result.outcome === "captured" && file)
        this.captures.set(result.capture.id, file);
      return result;
    } finally {
      this.capturing = false;
      if (this.window && !this.window.isDestroyed()) this.reveal(this.window);
    }
  }

  private async submit(value: unknown): Promise<void> {
    const submission = parseQuickInputSubmission(value);
    const images = submission.captureIds.map((id) => {
      const file = this.captures.get(id);
      if (!file) throw new Error("That capture is no longer available");
      return file;
    });
    await this.options.onSubmit({
      workspace: submission.workspace,
      prompt: submission.prompt,
      images,
    });
    this.captures.clear();
    this.window?.hide();
  }
}
