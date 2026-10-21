/**
 * Login-shell PTY hosted in the Electron main process.
 *
 * Control frames follow herdr-web-ui `server/pty/pty-host.mjs` and
 * `server/pty/session.ts`:
 *   {"t":"i","d":string}          write to the pty
 *   {"t":"r","c":number,"r":number} resize
 *   {"t":"p","paused":boolean}    pause or resume the native reader
 * Pause stops the reader (`pty.pause` / `pty.resume`) so a slow emulator can
 * apply backpressure, and stopping the session resumes the reader before
 * kill so a paused child is not left stuck. Output itself is raw text, the
 * same role as the host's stdout.
 *
 * Copyright (c) 2026 devswha for the control-frame and pause/resume behavior,
 * MIT License. See THIRD_PARTY_NOTICES.md. This process spawns node-pty
 * directly; it does not launch the herdr sidecar.
 */

import { spawn as spawnNative, type IPty } from "node-pty";
import {
  TERMINAL_MAX_INPUT_CHARS,
  clampTerminalDimension,
  loginShellPlan,
  resolveShellCwd,
  type LoginShellCommand,
} from "./terminal-shell.js";

export interface TerminalControlInput {
  t: "i";
  d: string;
}
export interface TerminalControlResize {
  t: "r";
  c: unknown;
  r: unknown;
}
export interface TerminalControlPause {
  t: "p";
  paused: boolean;
}
export type TerminalControlFrame =
  | TerminalControlInput
  | TerminalControlResize
  | TerminalControlPause;

export interface TerminalExitStatus {
  exitCode: number;
  signal?: number;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): { dispose(): void };
}

export interface LoginShellOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  onData: (data: string) => void;
  onExit: (status: TerminalExitStatus) => void;
  spawn?: (
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ) => PtyProcess;
}

export class LoginShellSession {
  private readonly pty: PtyProcess;
  private paused = false;
  private exited = false;
  private disposed = false;
  private cols: number;
  private rows: number;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(command: LoginShellCommand, options: LoginShellOptions) {
    const cwd = resolveShellCwd(options.cwd);
    this.cols = clampTerminalDimension(options.cols ?? 80);
    this.rows = clampTerminalDimension(options.rows ?? 24);
    const spawn = options.spawn ?? defaultSpawn;
    this.pty = spawn(command.file, command.args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd,
      env: ptyEnvironment(options.env ?? process.env, cwd),
    });
    this.pty.onData((data) => {
      if (this.exited) return;
      options.onData(data);
    });
    this.pty.onExit((event) => {
      this.markExited(options, event.exitCode, event.signal);
    });
  }

  /**
   * Applies one control frame. Unknown frames and input after exit are ignored
   * so a late renderer message cannot throw in the main process.
   */
  handle(frame: TerminalControlFrame): void {
    if (this.exited || this.disposed) return;
    if (frame.t === "i") {
      if (typeof frame.d !== "string" || frame.d.length === 0) return;
      if (frame.d.length > TERMINAL_MAX_INPUT_CHARS) return;
      this.pty.write(frame.d);
      return;
    }
    if (frame.t === "r") {
      const cols = clampTerminalDimension(frame.c);
      const rows = clampTerminalDimension(frame.r);
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      this.pty.resize(cols, rows);
      return;
    }
    if (frame.t === "p") {
      if (frame.paused === this.paused) return;
      this.paused = frame.paused;
      if (frame.paused) this.pty.pause();
      else this.pty.resume();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // A paused reader still needs to observe the child going away.
    try {
      this.pty.resume();
    } catch {
      // The process is already gone.
    }
    try {
      this.pty.kill();
    } catch {
      // The process is already gone.
    }
    this.killTimer = setTimeout(() => {
      try {
        this.pty.kill("SIGKILL");
      } catch {
        // The process is already gone.
      }
    }, 2000);
    this.killTimer.unref?.();
  }

  private markExited(
    options: LoginShellOptions,
    exitCode: number,
    signal: number | undefined,
  ): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.exited) return;
    this.exited = true;
    options.onExit({
      exitCode: Number.isInteger(exitCode) ? exitCode : 0,
      signal,
    });
  }
}

export function openLoginShell(options: LoginShellOptions): LoginShellSession {
  const plan = loginShellPlan(options.env, options.platform);
  let lastError: unknown;
  for (const command of plan) {
    try {
      return new LoginShellSession(command, options);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("Could not spawn a login shell");
}

function defaultSpawn(
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
): IPty {
  return spawnNative(file, args, options);
}

function ptyEnvironment(
  source: NodeJS.ProcessEnv,
  cwd: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.PWD = cwd;
  return env;
}
