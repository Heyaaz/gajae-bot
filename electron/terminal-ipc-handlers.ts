import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import type { IpcSecurity } from "./ipc-security.js";
import { resolveShellCwd } from "./terminal-shell.js";
import {
  openLoginShell,
  type LoginShellOptions,
  type LoginShellSession,
} from "./terminal-session.js";
import {
  TERMINAL_IPC,
  type TerminalExitEvent,
  type TerminalOutputEvent,
  type TerminalStartRequest,
} from "../shared/terminal-ipc.js";

interface TerminalSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

interface LiveSession {
  id: string;
  token: number;
  session: LoginShellSession;
}

/**
 * One login shell per renderer. Output, exit, and disposal are tied to that
 * renderer's webContents, and closing the window kills the shell.
 */
export class TerminalHost {
  private readonly sessions = new Map<number, LiveSession>();
  private readonly cancelled = new Map<number, Set<number>>();

  constructor(
    private readonly open: (
      options: LoginShellOptions,
    ) => LoginShellSession = openLoginShell,
  ) {}

  start(sender: TerminalSender, request: TerminalStartRequest): { id: string; cwd: string } {
    const token = request.token;
    if (this.takeCancel(sender.id, token)) {
      throw new Error("Terminal start was cancelled");
    }
    this.kill(sender.id);
    const id = randomUUID();
    const cwd = resolveShellCwd(request.cwd);
    const session = this.open({
      cwd,
      cols: request.cols,
      rows: request.rows,
      onData: (data) => {
        const current = this.sessions.get(sender.id);
        if (!current || current.id !== id || sender.isDestroyed()) return;
        const payload: TerminalOutputEvent = { id, data };
        sender.send(TERMINAL_IPC.output, payload);
      },
      onExit: (status) => {
        const current = this.sessions.get(sender.id);
        if (!current || current.id !== id) return;
        this.sessions.delete(sender.id);
        if (sender.isDestroyed()) return;
        const payload: TerminalExitEvent = {
          id,
          exitCode: status.exitCode,
          signal: status.signal,
        };
        sender.send(TERMINAL_IPC.exit, payload);
      },
    });
    if (this.takeCancel(sender.id, token)) {
      session.dispose();
      throw new Error("Terminal start was cancelled");
    }
    this.sessions.set(sender.id, { id, token, session });
    return { id, cwd };
  }

  write(senderId: number, data: unknown): void {
    if (typeof data !== "string") return;
    this.sessions.get(senderId)?.session.handle({ t: "i", d: data });
  }

  resize(senderId: number, cols: unknown, rows: unknown): void {
    this.sessions.get(senderId)?.session.handle({ t: "r", c: cols, r: rows });
  }

  setPaused(senderId: number, paused: unknown): void {
    if (typeof paused !== "boolean") return;
    this.sessions.get(senderId)?.session.handle({ t: "p", paused });
  }

  dispose(senderId: number, token?: number): void {
    if (typeof token === "number") this.cancel(senderId, token);
    const current = this.sessions.get(senderId);
    if (token !== undefined && current && current.token !== token) return;
    this.kill(senderId);
  }

  disposeAll(): void {
    for (const senderId of [...this.sessions.keys()]) this.kill(senderId);
    this.cancelled.clear();
  }

  private cancel(senderId: number, token: number): void {
    let tokens = this.cancelled.get(senderId);
    if (!tokens) {
      tokens = new Set();
      this.cancelled.set(senderId, tokens);
    }
    tokens.add(token);
    if (tokens.size > 32) {
      const oldest = tokens.values().next().value;
      if (oldest !== undefined) tokens.delete(oldest);
    }
  }

  private takeCancel(senderId: number, token: number): boolean {
    const tokens = this.cancelled.get(senderId);
    if (!tokens?.has(token)) return false;
    tokens.delete(token);
    return true;
  }

  private kill(senderId: number): void {
    const current = this.sessions.get(senderId);
    this.sessions.delete(senderId);
    current?.session.dispose();
  }
}

export function terminalStartRequest(value: unknown): TerminalStartRequest {
  const request = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const token = request.token;
  if (typeof token !== "number" || !Number.isSafeInteger(token) || token <= 0) {
    throw new Error("Terminal token is required");
  }
  return {
    token,
    cwd: typeof request.cwd === "string" ? request.cwd : undefined,
    cols: typeof request.cols === "number" ? request.cols : undefined,
    rows: typeof request.rows === "number" ? request.rows : undefined,
  };
}

export function registerTerminalIpcHandlers(
  security: IpcSecurity,
  options?: { open?: (sessionOptions: LoginShellOptions) => LoginShellSession },
): { unregister(): void; bindWindow(window: BrowserWindow): void; disposeAll(): void } {
  const host = new TerminalHost(options?.open);

  ipcMain.handle(
    TERMINAL_IPC.start,
    security.guarded((event: IpcMainInvokeEvent, request: unknown) =>
      host.start(event.sender, terminalStartRequest(request)),
    ),
  );
  ipcMain.handle(
    TERMINAL_IPC.dispose,
    security.guarded((event: IpcMainInvokeEvent, token: unknown) => {
      host.dispose(event.sender.id, typeof token === "number" ? token : undefined);
    }),
  );

  const onInput = (event: IpcMainEvent, data: unknown): void => {
    if (!security.isAllowed(event as unknown as IpcMainInvokeEvent)) return;
    host.write(event.sender.id, data);
  };
  const onResize = (event: IpcMainEvent, cols: unknown, rows: unknown): void => {
    if (!security.isAllowed(event as unknown as IpcMainInvokeEvent)) return;
    host.resize(event.sender.id, cols, rows);
  };
  const onPause = (event: IpcMainEvent, paused: unknown): void => {
    if (!security.isAllowed(event as unknown as IpcMainInvokeEvent)) return;
    host.setPaused(event.sender.id, paused);
  };
  ipcMain.on(TERMINAL_IPC.input, onInput);
  ipcMain.on(TERMINAL_IPC.resize, onResize);
  ipcMain.on(TERMINAL_IPC.pause, onPause);

  return {
    unregister(): void {
      host.disposeAll();
      ipcMain.removeHandler(TERMINAL_IPC.start);
      ipcMain.removeHandler(TERMINAL_IPC.dispose);
      ipcMain.removeListener(TERMINAL_IPC.input, onInput);
      ipcMain.removeListener(TERMINAL_IPC.resize, onResize);
      ipcMain.removeListener(TERMINAL_IPC.pause, onPause);
    },
    bindWindow(window: BrowserWindow): void {
      const senderId = window.webContents.id;
      const dispose = (): void => host.dispose(senderId);
      window.on("closed", dispose);
      window.webContents.once("destroyed", dispose);
    },
    disposeAll(): void {
      host.disposeAll();
    },
  };
}
