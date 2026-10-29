import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, unlinkSync } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  QuickInputShortcutStatus,
  ScreenCaptureResult,
} from "../shared/quick-input.js";

/** The slice of Electron's `globalShortcut` this module uses, so tests can fake it. */
export interface GlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/**
 * Keeps at most one global shortcut registered for the quick input window.
 *
 * `apply` converges on the accelerator it is given, so the settings handler can
 * call it on every save: the same live accelerator is left alone, and a failed
 * one is tried again in case the other app has let go of it.
 */
export class QuickInputShortcut {
  private current: QuickInputShortcutStatus = { state: "off" };

  constructor(
    private readonly api: GlobalShortcutApi,
    private readonly onTrigger: () => void,
  ) {}

  apply(accelerator: string): QuickInputShortcutStatus {
    if (
      this.current.state === "registered" &&
      this.current.accelerator === accelerator
    )
      return this.current;
    this.release();
    if (!accelerator) return this.current;
    if (!hasModifier(accelerator)) {
      // A bare key would be taken from every app, typing included.
      this.current = { state: "failed", accelerator, reason: "invalid" };
      return this.current;
    }
    try {
      this.current = this.api.register(accelerator, this.onTrigger)
        ? { state: "registered", accelerator }
        : { state: "failed", accelerator, reason: "unavailable" };
    } catch {
      // Electron throws a TypeError for an accelerator it cannot parse.
      this.current = { state: "failed", accelerator, reason: "invalid" };
    }
    return this.current;
  }

  status(): QuickInputShortcutStatus {
    return this.current;
  }

  dispose(): void {
    this.release();
  }

  private release(): void {
    if (this.current.state === "registered")
      this.api.unregister(this.current.accelerator);
    this.current = { state: "off" };
  }
}

const MODIFIERS = new Set([
  "command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl",
  "alt", "option", "altgr", "super", "meta",
]);

// Shift alone does not count: Shift+A would still capture capital letters.
function hasModifier(accelerator: string): boolean {
  const parts = accelerator.split("+").map((part) => part.trim().toLowerCase());
  return parts.slice(0, -1).some((part) => MODIFIERS.has(part));
}

export type ScreenAccess =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export interface ScreenCaptureOptions {
  directory: string;
  /** `systemPreferences.getMediaAccessStatus("screen")`. */
  screenAccess(): ScreenAccess;
  /** Runs `screencapture` and resolves once the user has finished or cancelled. */
  runCapture?(file: string): Promise<void>;
  now?(): number;
  /** Re-encodes a PNG at `factor` of its size; absent means oversized captures fail. */
  downscale?(png: Buffer, factor: number): Buffer;
}

/** The attachment limit for an image (`imageAttachment`), checked here so it fails at capture. */
export const CAPTURE_MAX_BYTES = 10 * 1024 * 1024;
const DOWNSCALE_FACTOR = 0.7;
const DOWNSCALE_ATTEMPTS = 8;

const CAPTURE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Lets the user pick a screen region or window and returns it as a PNG.
 *
 * A denied Screen Recording permission is answered before `screencapture` runs:
 * macOS asks only once, so running it again would show the user nothing new.
 */
export async function captureScreen(
  options: ScreenCaptureOptions,
): Promise<ScreenCaptureResult & { file?: string }> {
  if (deniedAccess(options.screenAccess()))
    return { outcome: "permission-denied" };
  const now = options.now?.() ?? Date.now();
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await pruneCaptures(options.directory, now);
  const name = `capture-${new Date(now).toISOString().replace(/[:.]/gu, "-")}.png`;
  const file = path.join(options.directory, name);
  try {
    await (options.runCapture ?? runScreencapture)(file);
  } catch (error) {
    return {
      outcome: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  let data = await readFile(file).catch(() => undefined);
  if (data && data.length > CAPTURE_MAX_BYTES) {
    const fitted = fitToLimit(data, options.downscale);
    if (!fitted) {
      await unlink(file).catch(() => undefined);
      return {
        outcome: "failed",
        message: "캡처가 10 MiB 제한을 초과합니다. 더 작은 영역을 선택해 주세요.",
      };
    }
    // The submitted file is the one the attachment limit is checked against.
    await writeFile(file, fitted);
    data = fitted;
  }
  if (!data || data.length === 0) {
    // No file is what both Escape and a refusal leave behind; only the
    // permission state tells them apart.
    return deniedAccess(options.screenAccess())
      ? { outcome: "permission-denied" }
      : { outcome: "cancelled" };
  }
  return {
    outcome: "captured",
    capture: { id: randomUUID(), name, data: data.toString("base64") },
    file,
  };
}

function fitToLimit(
  png: Buffer,
  downscale: ScreenCaptureOptions["downscale"],
): Buffer | undefined {
  if (!downscale) return undefined;
  let current = png;
  let scale = 1;
  for (let attempt = 0; attempt < DOWNSCALE_ATTEMPTS; attempt += 1) {
    scale *= DOWNSCALE_FACTOR;
    try {
      current = downscale(png, scale);
    } catch {
      return undefined;
    }
    if (current.length > 0 && current.length <= CAPTURE_MAX_BYTES) return current;
  }
  return undefined;
}

function deniedAccess(access: ScreenAccess): boolean {
  return access === "denied" || access === "restricted";
}

function runScreencapture(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/sbin/screencapture",
      ["-i", "-x", "-t", "png", file],
      // Escape exits 1 on some macOS releases and 0 on others, so an exit status
      // is not a failure; the file is the answer. A string code is a spawn error.
      (error) =>
        typeof (error as NodeJS.ErrnoException | null)?.code === "string"
          ? reject(error)
          : resolve(),
    );
    child.stdin?.end();
  });
}

/**
 * Screenshots older than an attachment token's lifetime can no longer be sent,
 * and they may hold whatever was on screen, so they are not kept around.
 */
async function pruneCaptures(directory: string, now: number): Promise<void> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => /^capture-.*\.png$/u.test(entry))
      .map(async (entry) => {
        const file = path.join(directory, entry);
        const info = await stat(file).catch(() => undefined);
        if (info && now - info.mtimeMs > CAPTURE_LIFETIME_MS)
          await unlink(file).catch(() => undefined);
      }),
  );
}

/**
 * Deletes every screenshot this feature left behind. Attachment tokens live only
 * in memory, so no capture is referenced before startup or after quit, and the
 * files may hold whatever was on screen.
 */
export function removeCaptures(directory: string): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^capture-.*\.png$/u.test(entry)) continue;
    try {
      unlinkSync(path.join(directory, entry));
    } catch {
      // Already gone, or not ours to remove; the age-based pruning still runs.
    }
  }
}
