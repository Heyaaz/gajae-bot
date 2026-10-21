/**
 * Desktop terminal bridge.
 *
 * The renderer never chooses the program. Main spawns the user's login shell
 * and this channel set only carries bytes, size, and flow control.
 */

export const TERMINAL_IPC = {
  start: "agent-control:terminal:start",
  input: "agent-control:terminal:input",
  resize: "agent-control:terminal:resize",
  pause: "agent-control:terminal:pause",
  dispose: "agent-control:terminal:dispose",
  output: "agent-control:terminal:output",
  exit: "agent-control:terminal:exit",
} as const;

export interface TerminalStartRequest {
  /** Working directory. Main ignores anything that is not an existing directory. */
  cwd?: string;
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
  write(data: string): void;
  resize(cols: number, rows: number): void;
  setPaused(paused: boolean): void;
  dispose(token: number): Promise<void>;
  onOutput(listener: (event: TerminalOutputEvent) => void): () => void;
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
}
