import { homedir } from "node:os";
import { validDirectory } from "./settings-store.js";

/** Largest dimension the control frame will apply. Matches the pty-host clamp. */
export const TERMINAL_MAX_DIMENSION = 1000;
/** A paste larger than this is dropped rather than split mid-sequence. */
export const TERMINAL_MAX_INPUT_CHARS = 1024 * 1024;

export interface LoginShellCommand {
  file: string;
  args: string[];
}

/**
 * The shell named by `SHELL` when it is a safe path, otherwise a platform
 * default. Every Unix candidate is started as a login shell (`-l`).
 */
export function loginShellPlan(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LoginShellCommand[] {
  const commands: LoginShellCommand[] = [];
  const push = (file: string | undefined, args: string[]): void => {
    if (!file || !isAcceptableShell(file)) return;
    if (commands.some((command) => command.file === file)) return;
    commands.push({ file, args });
  };

  if (platform === "win32") {
    const requested = env.COMSPEC || env.ComSpec;
    const powershell = /powershell(?:\.exe)?$|pwsh(?:\.exe)?$/i;
    push(requested, powershell.test(requested ?? "") ? ["-NoLogo"] : []);
    push("powershell.exe", ["-NoLogo"]);
    push("cmd.exe", []);
    return commands;
  }

  push(env.SHELL, ["-l"]);
  if (platform === "darwin") push("/bin/zsh", ["-l"]);
  push("/bin/bash", ["-l"]);
  push("/bin/sh", ["-l"]);
  return commands;
}

export function resolveShellCwd(
  candidate: unknown,
  fallback: string = homedir(),
): string {
  if (validDirectory(candidate)) return candidate;
  if (validDirectory(fallback)) return fallback;
  return homedir();
}

/**
 * Columns and rows from a control frame. Non-finite or non-positive values
 * collapse to 1, and anything above {@link TERMINAL_MAX_DIMENSION} is capped.
 *
 * Adapted from herdr-web-ui `server/pty/pty-host.mjs` (`clamp`).
 * Copyright (c) 2026 devswha, MIT License. See THIRD_PARTY_NOTICES.md.
 */
export function clampTerminalDimension(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(Math.floor(parsed), TERMINAL_MAX_DIMENSION);
}

function isAcceptableShell(file: string): boolean {
  const value = file.trim();
  if (!value || value.length > 4096) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) return true;
  return /^[\w.+-]+$/u.test(value);
}
