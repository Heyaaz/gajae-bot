/**
 * Desktop terminal bridge.
 *
 * The renderer never chooses the program. Main spawns the user's login shell
 * and this channel set only carries bytes, size, and flow control.
 */

import type { AgentSession } from "./agent-contract.js";

export const TERMINAL_IPC = {
  start: "agent-control:terminal:start",
  input: "agent-control:terminal:input",
  resize: "agent-control:terminal:resize",
  pause: "agent-control:terminal:pause",
  dispose: "agent-control:terminal:dispose",
  output: "agent-control:terminal:output",
  exit: "agent-control:terminal:exit",
  listSessions: "agent-control:terminal:list-sessions",
  createSession: "agent-control:terminal:create-session",
  renameSession: "agent-control:terminal:rename-session",
  confirmSessionRemoval: "agent-control:terminal:confirm-session-removal",
  deleteSession: "agent-control:terminal:delete-session",
} as const;

/** Terminal session ids carry this prefix, so a session row says which runtime owns it. */
export const TERMINAL_SESSION_PREFIX = "terminal-";

export function isTerminalSessionId(sessionId: string): boolean {
  return sessionId.startsWith(TERMINAL_SESSION_PREFIX);
}

/**
 * A terminal session as the app stores it. GJC's broker never sees these; the
 * shell behind one lives only while the window that opened it does.
 */
export interface TerminalSessionRecord {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
}

export interface TerminalSessionCreateInput {
  title: string;
  workspace: string;
}

export interface TerminalStartRequest {
  /** Working directory. Main ignores anything that is not an existing directory. */
  cwd?: string;
  /**
   * A terminal session to attach to. Its shell outlives the view: starting again
   * replays what it printed instead of opening a new one. Main takes the folder
   * from the stored session, not from `cwd`.
   */
  session?: string;
  /** Replaces the session's shell, even a running one, with a fresh one. */
  restart?: boolean;
  cols?: number;
  rows?: number;
  /**
   * Pairs this start with the dispose that cancels it. A dispose for the same
   * token wins even when it is processed first.
   */
  token: number;
}

export interface TerminalSessionInfo {
  id: string;
  /** Directory the shell actually started in. Missing paths fall back to home. */
  cwd: string;
  /** Output so far, for a view attaching to a session shell that was already running. */
  replay?: string;
  /** Set when the session's shell has already exited. */
  exitCode?: number;
}

export interface TerminalOutputEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number;
  signal?: number;
}

export interface TerminalDesktopBridge {
  start(request: TerminalStartRequest): Promise<TerminalSessionInfo>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  setPaused(id: string, paused: boolean): void;
  dispose(token: number): Promise<void>;
  listSessions(): Promise<AgentSession[]>;
  createSession(input: TerminalSessionCreateInput): Promise<AgentSession>;
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Asks the user, in the host's own dialog, before the session and its shell go away. */
  confirmSessionRemoval(sessionId: string): Promise<boolean>;
  deleteSession(sessionId: string): Promise<void>;
  onOutput(listener: (event: TerminalOutputEvent) => void): () => void;
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
}
