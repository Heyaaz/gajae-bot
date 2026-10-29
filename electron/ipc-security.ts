import { BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostText } from "./host-text.js";

export interface RendererLaunchConfig {
  developmentUrl?: string;
  mockSmokeMode: boolean;
  gjcSmokeMode: boolean;
  smokeMode: boolean;
  /** Loads the mock backend without the assertion harness, for the terminal view. */
  terminalSmokeMode: boolean;
  /** Loads the mock backend and drives gajae:// links through the real handlers. */
  deepLinkSmokeMode: boolean;
}

export function rendererLaunchConfig(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): RendererLaunchConfig {
  if (isPackaged)
    return {
      developmentUrl: undefined,
      mockSmokeMode: false,
      gjcSmokeMode: false,
      smokeMode: false,
      terminalSmokeMode: false,
      deepLinkSmokeMode: false,
    };
  const developmentUrl = env.VITE_DEV_SERVER_URL?.trim() || undefined;
  const mockSmokeMode = argv.includes("--smoke");
  const gjcSmokeMode = argv.includes("--gjc-smoke");
  const terminalSmokeMode = argv.includes("--terminal-smoke");
  const deepLinkSmokeMode = argv.includes("--deep-link-smoke");
  return {
    developmentUrl,
    mockSmokeMode,
    gjcSmokeMode,
    smokeMode: mockSmokeMode || gjcSmokeMode,
    terminalSmokeMode,
    deepLinkSmokeMode,
  };
}

export type DestructiveConfirmation = (options: {
  window: BrowserWindow;
  message: string;
  detail?: string;
}) => Promise<boolean>;

export const nativeDestructiveConfirmation: DestructiveConfirmation = async ({
  window,
  message,
  detail,
}) => {
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Cancel", "Continue"],
    defaultId: 0,
    cancelId: 0,
    message: hostText(message),
    detail: detail ? hostText(detail) : undefined,
  });
  return result.response === 1;
};

export class IpcSecurity {
  private readonly windows = new Map<number, { window: BrowserWindow; url: string; cleanup: () => void }>();
  private readonly pendingAuthorizations = new Set<number>();
  private disposed = false;
  constructor(private readonly confirm: DestructiveConfirmation = nativeDestructiveConfirmation) {}

  register(window: BrowserWindow, expectedUrl: string): () => void {
    if (this.disposed || window.isDestroyed() || window.webContents.isDestroyed()) return () => undefined;
    const id = window.webContents.id;
    this.windows.get(id)?.cleanup();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.windows.delete(id);
    };
    window.once("closed", cleanup);
    window.webContents.once("destroyed", cleanup);
    this.windows.set(id, { window, url: expectedUrl, cleanup });
    return cleanup;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.windows.values()) entry.cleanup();
    this.windows.clear();
    this.pendingAuthorizations.clear();
  }

  isAllowed(event: IpcMainInvokeEvent): boolean {
    if (this.disposed) return false;
    const entry = this.windows.get(event.sender.id);
    if (
      !entry ||
      entry.window.isDestroyed() ||
      event.sender.isDestroyed() ||
      entry.window.webContents !== event.sender
    )
      return false;
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) return false;
    return frame.url === entry.url;
  }

  guarded<T extends (...args: any[]) => any>(handler: T): T {
    return ((event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!this.isAllowed(event)) throw new Error("Unauthorized IPC sender");
      return handler(event, ...args);
    }) as T;
  }

  async authorizeDestructive(
    event: IpcMainInvokeEvent,
    options: { message: string; detail?: string },
  ): Promise<void> {
    const window = this.owner(event);
    const senderId = event.sender.id;
    if (this.pendingAuthorizations.has(senderId))
      throw new Error("Another confirmation is already in progress");
    this.pendingAuthorizations.add(senderId);
    try {
      const confirmed = await this.confirm({ ...options, window });
      if (!confirmed) throw new Error("Operation cancelled");
      if (!this.isAllowed(event)) throw new Error("Unauthorized IPC sender");
    } finally {
      this.pendingAuthorizations.delete(senderId);
    }
  }

  owner(event: IpcMainInvokeEvent): BrowserWindow {
    if (!this.isAllowed(event)) throw new Error("Unauthorized IPC sender");
    const entry = this.windows.get(event.sender.id);
    if (!entry) throw new Error("Unauthorized IPC sender");
    return entry.window;
  }
}

export function expectedTopLevelUrl(
  developmentUrl: string | undefined,
  appPath: string,
  mock = false,
): string {
  if (developmentUrl?.trim()) {
    const url = new URL(developmentUrl.trim());
    url.hash = "";
    return url.toString();
  }
  const url = pathToFileURL(path.join(appPath, "dist/index.html"));
  if (mock) url.searchParams.set("backend", "mock");
  return url.toString();
}
