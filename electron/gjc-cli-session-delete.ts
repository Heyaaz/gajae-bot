import { access } from "node:fs/promises";
import { spawn as spawnNative } from "node-pty";

/**
 * Deletes one saved session through GJC's own interactive `/session delete`.
 *
 * The broker's `session.delete` is refused on a machine whose lifecycle ledger
 * holds legacy rows (`lifecycle_legacy_history_ambiguous`, gjc/0.19.2), and GJC
 * forbids editing that ledger. The interactive command removes the transcript
 * and artifacts through GJC's session store instead, and `gjc -p` does not run
 * slash commands (it sends them to the model), so the command is typed into a
 * hidden terminal.
 *
 * Every key answers what GJC printed since the previous key, never the whole
 * scrollback: a startup dialog (first-run onboarding on a fresh agent dir) can
 * open after the editor was drawn, and an Enter meant for the editor would pick
 * one of its options. So the command is typed only into a freshly drawn editor,
 * Enter is sent only while the echoed command and at most its own completion
 * entry are on screen (a first Enter can be taken by that completion list), any
 * other dialog gets Esc, and Yes is chosen only on GJC's own deletion prompt with
 * Yes already selected. Success is the transcript gone from disk; GJC is stopped
 * either way, so the empty session it opens after deleting is never used.
 */

export interface CliDeleteTerminal {
  write(data: string): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export type SpawnCliDeleteTerminal = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => CliDeleteTerminal;

export interface CliDeleteOptions {
  executable: string;
  cwd: string;
  /** The transcript `--resume` opens; its removal is the proof of deletion. */
  sessionPath: string;
  env: NodeJS.ProcessEnv;
  spawn?: SpawnCliDeleteTerminal;
  transcriptExists?: (sessionPath: string) => Promise<boolean>;
  timeoutMs?: number;
  quietMs?: number;
}

export class CliDeleteError extends Error {
  constructor(
    readonly reason: "timeout" | "exited" | "unexpected-dialog",
    message: string,
  ) {
    super(message);
    this.name = "CliDeleteError";
  }
}

const DELETE_PROMPT = "Delete current session transcript and artifacts?";
const COMMAND = "/session delete";
const SELECTION_POINTER = /❯\s*(\S+)/gu;
const YES_SELECTED = /❯\s*Yes/u;
const EDITOR_READY = "Type your message";
const DIALOG_HINT = "Esc cancel";
const MAX_DIALOG_DISMISSALS = 3;
const MAX_SUBMITS = 2;
const POLL_MS = 100;
const KILL_GRACE_MS = 2_000;

const stripTerminalControls = (text: string): string =>
  text.replace(
    // CSI, OSC (BEL or ST terminated), and the remaining two-byte escapes.
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/gu,
    "",
  );

/** The typed command is on screen with nothing selectable but its own completion. */
function editorHoldsCommand(text: string): boolean {
  if (!text.includes(COMMAND)) return false;
  return [...text.matchAll(SELECTION_POINTER)].every((match) => match[1] === "delete");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function terminalEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === "string") env[key] = value;
  env.TERM = "xterm-256color";
  // GJC skips its first-run onboarding dialog under automation; on an agent dir
  // that never ran the TUI it otherwise opens over the editor and swallows the
  // typed command.
  env.GJC_AUTOMATION = "1";
  return env;
}

export function deleteSessionThroughCli(options: CliDeleteOptions): Promise<void> {
  const spawn = options.spawn ?? spawnNative;
  const transcriptExists = options.transcriptExists ?? fileExists;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const quietMs = options.quietMs ?? 1_000;
  const terminal = spawn(options.executable, ["--resume", options.sessionPath, "--no-mcp", "--no-lsp"], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: options.cwd,
    env: terminalEnvironment(options.env),
  });

  return new Promise<void>((resolve, reject) => {
    let stage: "starting" | "typed" | "confirmed" = "starting";
    // Output since the last key this side sent.
    let fresh = "";
    let lastOutputAt = Date.now();
    let dismissals = 0;
    let submits = 0;
    let checking = false;
    let exited = false;
    let settled = false;
    const startedAt = Date.now();

    const send = (keys: string): void => {
      fresh = "";
      terminal.write(keys);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      output.dispose();
      if (!exited) {
        terminal.kill("SIGTERM");
        const force = setTimeout(() => {
          if (!exited) terminal.kill("SIGKILL");
        }, KILL_GRACE_MS);
        force.unref?.();
      }
      if (error) reject(error);
      else resolve();
    };

    const output = terminal.onData((data) => {
      fresh += data;
      lastOutputAt = Date.now();
    });
    const exit = terminal.onExit(() => {
      exited = true;
      exit.dispose();
      if (!settled)
        void transcriptExists(options.sessionPath).then((present) =>
          finish(
            present
              ? new CliDeleteError("exited", "GJC가 세션 삭제 전에 종료됐습니다.")
              : undefined,
          ),
        );
    });

    const poll = setInterval(() => {
      if (settled || checking) return;
      if (Date.now() - startedAt > timeoutMs) {
        finish(new CliDeleteError("timeout", `GJC가 ${Math.round(timeoutMs / 1000)}초 안에 세션 삭제를 끝내지 못했습니다.`));
        return;
      }
      if (stage === "confirmed") {
        checking = true;
        void transcriptExists(options.sessionPath).then((present) => {
          checking = false;
          if (!present) finish();
        });
        return;
      }
      if (Date.now() - lastOutputAt < quietMs) return;
      // Stripped here rather than per chunk: a chunk can end inside an escape.
      const visible = stripTerminalControls(fresh);
      const prompted = visible.includes(DELETE_PROMPT);
      if (!prompted && visible.includes(DIALOG_HINT)) {
        if (dismissals >= MAX_DIALOG_DISMISSALS) {
          finish(new CliDeleteError("unexpected-dialog", "GJC가 세션 삭제 전에 닫을 수 없는 확인 창을 띄웠습니다."));
          return;
        }
        dismissals += 1;
        stage = "starting";
        send("\x1b");
      } else if (stage === "starting" && visible.includes(EDITOR_READY)) {
        stage = "typed";
        submits = 0;
        send(COMMAND);
      } else if (stage === "typed" && prompted) {
        if (!YES_SELECTED.test(visible)) {
          finish(new CliDeleteError("unexpected-dialog", "GJC의 삭제 확인 창에서 Yes가 선택되어 있지 않았습니다."));
          return;
        }
        stage = "confirmed";
        send("\r");
      } else if (stage === "typed" && submits < MAX_SUBMITS && editorHoldsCommand(visible)) {
        submits += 1;
        send("\r");
      }
    }, POLL_MS);
  });
}
