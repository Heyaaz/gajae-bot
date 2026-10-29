import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
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
}

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
  const data = await readFile(file).catch(() => undefined);
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
