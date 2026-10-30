import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentSession } from "../shared/agent-contract.js";
import type { IpcSecurity } from "./ipc-security.js";
import { recentLabel, timestampMs } from "./gjc-sdk-model.js";
import { validDirectory } from "./settings-store.js";
import { resolveShellCwd } from "./terminal-shell.js";
import {
  openLoginShell,
  type LoginShellOptions,
  type LoginShellSession,
} from "./terminal-session.js";
import type { TerminalSessionStore } from "./terminal-session-store.js";
import {
  TERMINAL_IPC,
  isTerminalSessionId,
  type TerminalExitEvent,
  type TerminalOutputEvent,
  type TerminalSessionInfo,
  type TerminalSessionRecord,
  type TerminalStartRequest,
} from "../shared/terminal-ipc.js";

interface TerminalSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/** The chat surface's shell, which lives only while its view does. */
const SURFACE_KEY = "";
/** What a terminal session replays to a view that attaches to it again. */
export const TERMINAL_REPLAY_LIMIT = 512 * 1024;
/** How long a delete waits for a closed session's program to finish exiting. */
const CLOSE_TIMEOUT_MS = 5_000;

interface LiveTerminal {
  id: string;
  /** {@link SURFACE_KEY}, or the terminal session this shell belongs to. */
  key: string;
  token: number;
  cwd: string;
  session: LoginShellSession;
  output: string;
  exitCode?: number;
  exited: Promise<void>;
}

/**
 * Shells per renderer. The chat surface keeps one shell that dies with its view;
 * each terminal session keeps its own, which outlives the view so switching
 * sessions and coming back finds it still running. Closing the window kills
 * every shell it opened.
 */
export class TerminalHost {
  private readonly windows = new Map<number, Map<string, LiveTerminal>>();
  private readonly cancelled = new Map<number, Set<number>>();

  constructor(
    private readonly openShell: (options: LoginShellOptions) => LoginShellSession = openLoginShell,
    private readonly lookup: (sessionId: string) => TerminalSessionRecord | undefined = () =>
      undefined,
  ) {}

  start(sender: TerminalSender, request: TerminalStartRequest): TerminalSessionInfo {
    const key = request.session ?? SURFACE_KEY;
    const token = request.token;
    if (this.takeCancel(sender.id, token)) throw new Error("Terminal start was cancelled");
    const stored = key === SURFACE_KEY ? undefined : this.lookup(key);
    if (key !== SURFACE_KEY && !stored) throw new Error("Terminal session not found");
    const current = this.windows.get(sender.id)?.get(key);
    if (current && key !== SURFACE_KEY && !request.restart) {
      current.session.handle({ t: "r", c: request.cols, r: request.rows });
      return {
        id: current.id,
        cwd: current.cwd,
        replay: current.output,
        ...(current.exitCode === undefined ? {} : { exitCode: current.exitCode }),
      };
    }
    this.kill(sender.id, key);
    const id = randomUUID();
    const cwd = resolveShellCwd(stored?.workspace ?? request.cwd);
    let markExited = (): void => undefined;
    const terminal: LiveTerminal = {
      id,
      key,
      token,
      cwd,
      session: undefined as unknown as LoginShellSession,
      output: "",
      exited: new Promise<void>((resolve) => {
        markExited = resolve;
      }),
    };
    const isCurrent = (): boolean => this.windows.get(sender.id)?.get(key) === terminal;
    const options: LoginShellOptions = {
      cwd,
      cols: request.cols,
      rows: request.rows,
      onData: (data) => {
        if (!isCurrent()) return;
        if (key !== SURFACE_KEY)
          terminal.output = (terminal.output + data).slice(-TERMINAL_REPLAY_LIMIT);
        if (sender.isDestroyed()) return;
        const payload: TerminalOutputEvent = { id, data };
        sender.send(TERMINAL_IPC.output, payload);
      },
      onExit: (status) => {
        markExited();
        if (!isCurrent()) return;
        if (key === SURFACE_KEY) this.windows.get(sender.id)?.delete(key);
        else terminal.exitCode = status.exitCode;
        if (sender.isDestroyed()) return;
        const payload: TerminalExitEvent = {
          id,
          exitCode: status.exitCode,
          signal: status.signal,
        };
        sender.send(TERMINAL_IPC.exit, payload);
      },
    };
    const session = this.openShell(options);
    if (this.takeCancel(sender.id, token)) {
      session.dispose();
      throw new Error("Terminal start was cancelled");
    }
    terminal.session = session;
    let terminals = this.windows.get(sender.id);
    if (!terminals) {
      terminals = new Map();
      this.windows.set(sender.id, terminals);
    }
    terminals.set(key, terminal);
    return { id, cwd };
  }

  write(senderId: number, id: unknown, data: unknown): void {
    if (typeof data !== "string") return;
    this.find(senderId, id)?.session.handle({ t: "i", d: data });
  }

  resize(senderId: number, id: unknown, cols: unknown, rows: unknown): void {
    this.find(senderId, id)?.session.handle({ t: "r", c: cols, r: rows });
  }

  setPaused(senderId: number, id: unknown, paused: unknown): void {
    if (typeof paused !== "boolean") return;
    this.find(senderId, id)?.session.handle({ t: "p", paused });
  }

  /** Ends the chat surface's shell. A terminal session's shell outlives its view. */
  dispose(senderId: number, token?: number): void {
    if (typeof token === "number") this.cancel(senderId, token);
    const current = this.windows.get(senderId)?.get(SURFACE_KEY);
    if (token !== undefined && current && current.token !== token) return;
    this.kill(senderId, SURFACE_KEY);
  }

  disposeWindow(senderId: number): void {
    for (const key of [...(this.windows.get(senderId)?.keys() ?? [])]) this.kill(senderId, key);
    this.windows.delete(senderId);
    this.cancelled.delete(senderId);
  }

  /**
   * Closes a terminal session's shells in every window the way closing a
   * terminal window does, and waits for them to exit.
   */
  async closeSession(sessionId: string): Promise<void> {
    const closing: Promise<unknown>[] = [];
    for (const [senderId, terminals] of this.windows) {
      const terminal = terminals.get(sessionId);
      if (!terminal) continue;
      this.kill(senderId, sessionId);
      if (terminal.exitCode === undefined)
        closing.push(
          Promise.race([
            terminal.exited,
            new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref?.()),
          ]),
        );
    }
    await Promise.all(closing);
  }

  disposeAll(): void {
    for (const senderId of [...this.windows.keys()]) this.disposeWindow(senderId);
    this.cancelled.clear();
  }


  private find(senderId: number, id: unknown): LiveTerminal | undefined {
    if (typeof id !== "string") return undefined;
    for (const terminal of this.windows.get(senderId)?.values() ?? [])
      if (terminal.id === id) return terminal;
    return undefined;
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

  private kill(senderId: number, key: string): void {
    const terminals = this.windows.get(senderId);
    const current = terminals?.get(key);
    terminals?.delete(key);
    current?.session.dispose();
  }
}

export function terminalStartRequest(value: unknown): TerminalStartRequest {
  const request = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const token = request.token;
  if (typeof token !== "number" || !Number.isSafeInteger(token) || token <= 0) {
    throw new Error("Terminal token is required");
  }
  const session = request.session;
  if (session !== undefined && (typeof session !== "string" || !isTerminalSessionId(session)))
    throw new Error("Terminal session ID is invalid");
  return {
    token,
    cwd: typeof request.cwd === "string" ? request.cwd : undefined,
    cols: typeof request.cols === "number" ? request.cols : undefined,
    rows: typeof request.rows === "number" ? request.rows : undefined,
    ...(session === undefined ? {} : { session }),
    ...(request.restart === true ? { restart: true } : {}),
  };
}

/** A terminal session as a session row: idle, attached, and owned by this app. */
export function terminalAgentSession(record: TerminalSessionRecord): AgentSession {
  return {
    id: record.id,
    title: record.title,
    subtitle: path.basename(record.workspace) || record.workspace,
    workspace: record.workspace,
    runtime: "terminal",
    status: "idle",
    updatedAt: recentLabel(record.createdAt),
    updatedAtMs: timestampMs(record.createdAt),
    pinned: false,
    unread: false,
    accent: "#56d4dd",
    ownership: "gajae",
    attachment: "attached",
  };
}

function terminalSessionId(value: unknown): string {
  if (typeof value !== "string" || !isTerminalSessionId(value))
    throw new Error("Terminal session ID is invalid");
  return value;
}

function removalConfirmation(record: TerminalSessionRecord | undefined) {
  return {
    message: "터미널 세션을 삭제할까요?",
    detail: [record?.title, "이 세션에서 실행 중인 셸과 프로그램을 종료합니다."]
      .filter(Boolean)
      .join("\n\n"),
    confirmLabel: "삭제",
    danger: true,
  };
}

export function registerTerminalIpcHandlers(
  security: IpcSecurity,
  options?: {
    open?: (sessionOptions: LoginShellOptions) => LoginShellSession;
    store?: TerminalSessionStore;
  },
): { unregister(): void; bindWindow(window: BrowserWindow): void; disposeAll(): void } {
  const store = options?.store;
  const host = new TerminalHost(options?.open, (sessionId) => store?.get(sessionId));
  const requireStore = (): TerminalSessionStore => {
    if (!store) throw new Error("Terminal sessions are not available");
    return store;
  };

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
  ipcMain.handle(
    TERMINAL_IPC.listSessions,
    security.guarded(() => (store?.list() ?? []).map(terminalAgentSession)),
  );
  ipcMain.handle(
    TERMINAL_IPC.createSession,
    security.guarded((_event: IpcMainInvokeEvent, input: unknown) => {
      const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      if (typeof value.title !== "string") throw new Error("Session title is required");
      if (!validDirectory(value.workspace)) throw new Error("Workspace must be an existing folder");
      return terminalAgentSession(
        requireStore().create({ title: value.title, workspace: value.workspace }),
      );
    }),
  );
  ipcMain.handle(
    TERMINAL_IPC.renameSession,
    security.guarded((_event: IpcMainInvokeEvent, sessionId: unknown, title: unknown) => {
      if (typeof title !== "string") throw new Error("Session title is required");
      requireStore().rename(terminalSessionId(sessionId), title);
    }),
  );
  ipcMain.handle(
    TERMINAL_IPC.confirmSessionRemoval,
    security.guarded((event: IpcMainInvokeEvent, sessionId: unknown) => {
      const id = terminalSessionId(sessionId);
      return security.preauthorize(event, `delete:${id}`, removalConfirmation(store?.get(id)));
    }),
  );
  ipcMain.handle(
    TERMINAL_IPC.deleteSession,
    security.guarded(async (event: IpcMainInvokeEvent, sessionId: unknown) => {
      const id = terminalSessionId(sessionId);
      const sessions = requireStore();
      await security.authorizeDestructive(event, removalConfirmation(sessions.get(id)), `delete:${id}`);
      await host.closeSession(id);
      sessions.delete(id);
    }),
  );

  const onInput = (event: IpcMainEvent, id: unknown, data: unknown): void => {
    if (!security.isAllowed(event as unknown as IpcMainInvokeEvent)) return;
    host.write(event.sender.id, id, data);
  };
  const onResize = (event: IpcMainEvent, id: unknown, cols: unknown, rows: unknown): void => {
    if (!security.isAllowed(event as unknown as IpcMainInvokeEvent)) return;
    host.resize(event.sender.id, id, cols, rows);
  };
  const onPause = (event: IpcMainEvent, id: unknown, paused: unknown): void => {
    if (!security.isAllowed(event as unknown as IpcMainInvokeEvent)) return;
    host.setPaused(event.sender.id, id, paused);
  };
  ipcMain.on(TERMINAL_IPC.input, onInput);
  ipcMain.on(TERMINAL_IPC.resize, onResize);
  ipcMain.on(TERMINAL_IPC.pause, onPause);

  return {
    unregister(): void {
      host.disposeAll();
      for (const channel of [
        TERMINAL_IPC.start,
        TERMINAL_IPC.dispose,
        TERMINAL_IPC.listSessions,
        TERMINAL_IPC.createSession,
        TERMINAL_IPC.renameSession,
        TERMINAL_IPC.confirmSessionRemoval,
        TERMINAL_IPC.deleteSession,
      ])
        ipcMain.removeHandler(channel);
      ipcMain.removeListener(TERMINAL_IPC.input, onInput);
      ipcMain.removeListener(TERMINAL_IPC.resize, onResize);
      ipcMain.removeListener(TERMINAL_IPC.pause, onPause);
    },
    bindWindow(window: BrowserWindow): void {
      const senderId = window.webContents.id;
      const dispose = (): void => host.disposeWindow(senderId);
      window.on("closed", dispose);
      window.webContents.once("destroyed", dispose);
    },
    disposeAll(): void {
      host.disposeAll();
    },
  };
}
