import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { confirmOverWindow, type ConfirmContent } from "./confirm-overlay.js";

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

export type DestructiveConfirmation = (
  options: ConfirmContent & { window: BrowserWindow },
) => Promise<boolean>;

export const overlayDestructiveConfirmation: DestructiveConfirmation = ({ window, ...content }) =>
  confirmOverWindow(window, content);

/** How long a confirmation answered ahead of its operation stays usable. */
const GRANT_TTL_MS = 30_000;

export class IpcSecurity {
  private readonly windows = new Map<number, { window: BrowserWindow; url: string; cleanup: () => void }>();
  private readonly pendingAuthorizations = new Set<number>();
  private readonly grants = new Map<string, number>();
  private disposed = false;
  constructor(private readonly prompt: DestructiveConfirmation = overlayDestructiveConfirmation) {}

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
    this.grants.clear();
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

  /** Asks the user through the host's own dialog; false when they decline. */
  async confirm(event: IpcMainInvokeEvent, content: ConfirmContent): Promise<boolean> {
    const window = this.owner(event);
    const senderId = event.sender.id;
    if (this.pendingAuthorizations.has(senderId))
      throw new Error("Another confirmation is already in progress");
    this.pendingAuthorizations.add(senderId);
    try {
      const confirmed = await this.prompt({ ...content, window });
      if (!this.isAllowed(event)) throw new Error("Unauthorized IPC sender");
      return confirmed;
    } finally {
      this.pendingAuthorizations.delete(senderId);
    }
  }

  /**
   * Throws unless the user confirms. A `grant` the same window earned through
   * `preauthorize` stands in for the prompt once.
   */
  async authorizeDestructive(
    event: IpcMainInvokeEvent,
    content: ConfirmContent,
    grant?: string,
  ): Promise<void> {
    if (grant !== undefined && this.consumeGrant(event, grant)) return;
    if (!(await this.confirm(event, content))) throw new Error("Operation cancelled");
  }

  /**
   * Confirms an operation before the window starts it, so the window can show the
   * outcome (a row leaving a list) the moment the user says yes. The operation's
   * own `authorizeDestructive` with the same grant then does not ask again.
   */
  async preauthorize(
    event: IpcMainInvokeEvent,
    grant: string,
    content: ConfirmContent,
  ): Promise<boolean> {
    const confirmed = await this.confirm(event, content);
    if (confirmed) this.grants.set(`${event.sender.id}:${grant}`, Date.now() + GRANT_TTL_MS);
    return confirmed;
  }

  private consumeGrant(event: IpcMainInvokeEvent, grant: string): boolean {
    if (!this.isAllowed(event)) throw new Error("Unauthorized IPC sender");
    const key = `${event.sender.id}:${grant}`;
    const expiresAt = this.grants.get(key);
    this.grants.delete(key);
    return expiresAt !== undefined && expiresAt >= Date.now();
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

/** The quick input window's top-level URL: the same renderer, asked for its small view. */
export function quickInputUrl(
  developmentUrl: string | undefined,
  appPath: string,
): string {
  const url = new URL(expectedTopLevelUrl(developmentUrl, appPath));
  url.searchParams.set("window", "quick-input");
  return url.toString();
}
