import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseQuickInputSubmission,
  quickInputProjects,
} from "../shared/quick-input.js";
import { QuickInputShortcut, captureScreen, CAPTURE_MAX_BYTES, removeCaptures, type GlobalShortcutApi } from "./quick-input.js";

function fakeShortcuts(taken: string[] = []) {
  const live = new Map<string, () => void>();
  const api: GlobalShortcutApi = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (accelerator.includes("Nope"))
        throw new TypeError(`conversion failure from ${accelerator}`);
      if (taken.includes(accelerator) || live.has(accelerator)) return false;
      live.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      live.delete(accelerator);
    }),
  };
  return { api, live };
}

describe("QuickInputShortcut", () => {
  it("registers, swaps and turns off the one shortcut it owns", () => {
    const { api, live } = fakeShortcuts();
    const trigger = vi.fn();
    const shortcut = new QuickInputShortcut(api, trigger);
    expect(shortcut.status()).toEqual({ state: "off" });

    expect(shortcut.apply("Control+Alt+Space")).toEqual({
      state: "registered",
      accelerator: "Control+Alt+Space",
    });
    live.get("Control+Alt+Space")?.();
    expect(trigger).toHaveBeenCalledOnce();

    expect(shortcut.apply("Control+Alt+Space").state).toBe("registered");
    expect(api.register).toHaveBeenCalledOnce();

    shortcut.apply("Command+Shift+K");
    expect([...live.keys()]).toEqual(["Command+Shift+K"]);

    expect(shortcut.apply("")).toEqual({ state: "off" });
    expect(live.size).toBe(0);
  });

  it("refuses a shortcut without a modifier so it cannot swallow ordinary typing", () => {
    const { api } = fakeShortcuts();
    const shortcut = new QuickInputShortcut(api, () => undefined);
    for (const bare of ["A", "Space", "Shift+K"])
      expect(shortcut.apply(bare)).toEqual({
        state: "failed",
        accelerator: bare,
        reason: "invalid",
      });
    expect(api.register).not.toHaveBeenCalled();
    expect(shortcut.apply("CommandOrControl+Shift+K").state).toBe("registered");
  });

  it("reports a refused or unparsable accelerator instead of throwing, and retries on the next apply", () => {
    const taken = ["Control+Alt+Space"];
    const { api, live } = fakeShortcuts(taken);
    const shortcut = new QuickInputShortcut(api, () => undefined);
    expect(shortcut.apply("Control+Alt+Space")).toEqual({
      state: "failed",
      accelerator: "Control+Alt+Space",
      reason: "unavailable",
    });
    expect(shortcut.apply("Control+Nope")).toEqual({
      state: "failed",
      accelerator: "Control+Nope",
      reason: "invalid",
    });
    taken.length = 0;
    expect(shortcut.apply("Control+Alt+Space").state).toBe("registered");
    shortcut.dispose();
    expect(live.size).toBe(0);
    expect(shortcut.status()).toEqual({ state: "off" });
  });
});

function captureDirectory(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "gajae-quick-input-")), "captures");
}

describe("captureScreen", () => {
  it("returns the picked region as a PNG kept on disk", async () => {
    const directory = captureDirectory();
    const result = await captureScreen({
      directory,
      screenAccess: () => "granted",
      runCapture: async (file) => writeFileSync(file, Buffer.from("png-bytes")),
    });
    expect(result.outcome).toBe("captured");
    if (result.outcome !== "captured") return;
    expect(Buffer.from(result.capture.data, "base64").toString()).toBe("png-bytes");
    expect(result.file && path.dirname(result.file)).toBe(directory);
    expect(readdirSync(directory)).toEqual([result.capture.name]);
  });

  it("shrinks a capture over the attachment limit so it can still be sent", async () => {
    const directory = captureDirectory();
    const big = Buffer.alloc(CAPTURE_MAX_BYTES + 1, 1);
    const result = await captureScreen({
      directory,
      screenAccess: () => "granted",
      runCapture: async (file) => writeFileSync(file, big),
      downscale: (png, factor) => Buffer.alloc(Math.round(png.length * factor), 2),
    });
    expect(result.outcome).toBe("captured");
    if (result.outcome !== "captured" || !result.file) return;
    const stored = readFileSync(result.file);
    expect(stored.length).toBeLessThanOrEqual(CAPTURE_MAX_BYTES);
    expect(Buffer.from(result.capture.data, "base64").length).toBe(stored.length);
  });

  it("fails at capture time when an oversized capture cannot be shrunk", async () => {
    const directory = captureDirectory();
    const result = await captureScreen({
      directory,
      screenAccess: () => "granted",
      runCapture: async (file) => writeFileSync(file, Buffer.alloc(CAPTURE_MAX_BYTES + 1)),
    });
    expect(result).toMatchObject({ outcome: "failed", message: expect.stringContaining("10 MiB") });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("removes leftover screenshots but nothing else", () => {
    const directory = captureDirectory();
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "capture-2026-01-01T00-00-00-000Z.png"), "x");
    writeFileSync(path.join(directory, "notes.txt"), "keep");
    removeCaptures(directory);
    expect(readdirSync(directory)).toEqual(["notes.txt"]);
    expect(() => removeCaptures(path.join(directory, "missing"))).not.toThrow();
  });

  it("does not run screencapture again once Screen Recording is denied", async () => {
    const runCapture = vi.fn(async () => undefined);
    for (const access of ["denied", "restricted"] as const)
      expect(
        await captureScreen({
          directory: captureDirectory(),
          screenAccess: () => access,
          runCapture,
        }),
      ).toEqual({ outcome: "permission-denied" });
    expect(runCapture).not.toHaveBeenCalled();
  });

  it("tells an Escape from a refusal by the permission after an empty capture", async () => {
    expect(
      await captureScreen({
        directory: captureDirectory(),
        screenAccess: () => "granted",
        runCapture: async () => undefined,
      }),
    ).toEqual({ outcome: "cancelled" });
    const answers = ["not-determined", "denied"] as const;
    let asked = 0;
    expect(
      await captureScreen({
        directory: captureDirectory(),
        screenAccess: () => answers[asked++],
        runCapture: async () => undefined,
      }),
    ).toEqual({ outcome: "permission-denied" });
  });

  it("reports a capture tool that could not start", async () => {
    expect(
      await captureScreen({
        directory: captureDirectory(),
        screenAccess: () => "granted",
        runCapture: async () => {
          throw new Error("spawn /usr/sbin/screencapture ENOENT");
        },
      }),
    ).toEqual({ outcome: "failed", message: "spawn /usr/sbin/screencapture ENOENT" });
  });

  it("drops captures older than a day before taking a new one", async () => {
    const directory = captureDirectory();
    const now = Date.parse("2026-10-29T12:00:00Z");
    await captureScreen({
      directory,
      screenAccess: () => "granted",
      runCapture: async () => undefined,
      now: () => now,
    });
    const stale = path.join(directory, "capture-old.png");
    const recent = path.join(directory, "capture-recent.png");
    const unrelated = path.join(directory, "notes.txt");
    for (const file of [stale, recent, unrelated]) writeFileSync(file, "x");
    utimesSync(stale, new Date(now - 25 * 3600_000), new Date(now - 25 * 3600_000));
    utimesSync(recent, new Date(now - 3600_000), new Date(now - 3600_000));
    utimesSync(unrelated, new Date(now - 48 * 3600_000), new Date(now - 48 * 3600_000));
    await captureScreen({
      directory,
      screenAccess: () => "granted",
      runCapture: async () => undefined,
      now: () => now,
    });
    expect(readdirSync(directory).sort()).toEqual(["capture-recent.png", "notes.txt"]);
  });
});

describe("quickInputProjects", () => {
  it("lists each project once, most recently active first, worktrees under their source", () => {
    expect(
      quickInputProjects(
        [
          { workspace: "/repo/a", updatedAtMs: 10 },
          {
            workspace: "/repo/b/.worktrees/issue-1",
            worktree: {
              managed: true,
              sourceWorkspace: "/repo/b",
              path: "/repo/b/.worktrees/issue-1",
              branch: "issue-1",
            },
            updatedAtMs: 30,
          },
          { workspace: "/repo/b", updatedAtMs: 20 },
          { workspace: "/repo/c" },
        ],
        "/Users/me/Documents",
      ),
    ).toEqual(["/repo/b", "/repo/a", "/repo/c", "/Users/me/Documents"]);
    expect(quickInputProjects([], "")).toEqual([]);
  });
});

describe("parseQuickInputSubmission", () => {
  it("accepts text, captures or both for an absolute workspace", () => {
    expect(
      parseQuickInputSubmission({ workspace: "/repo", prompt: "fix it", captureIds: [] }),
    ).toEqual({ workspace: "/repo", prompt: "fix it", captureIds: [] });
    expect(
      parseQuickInputSubmission({ workspace: "/repo", prompt: "", captureIds: ["c1"] }),
    ).toEqual({ workspace: "/repo", prompt: "", captureIds: ["c1"] });
  });

  it("refuses an empty, relative or malformed submission", () => {
    expect(() =>
      parseQuickInputSubmission({ workspace: "/repo", prompt: "  ", captureIds: [] }),
    ).toThrow("Quick input is empty");
    expect(() =>
      parseQuickInputSubmission({ workspace: "repo", prompt: "x", captureIds: [] }),
    ).toThrow("absolute path");
    expect(() =>
      parseQuickInputSubmission({ workspace: "/repo", prompt: "x", captureIds: [1] }),
    ).toThrow("captures are invalid");
    expect(() => parseQuickInputSubmission(null)).toThrow();
  });
});
