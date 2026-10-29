import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_IPC } from "../shared/settings-ipc.js";
import type { AttachmentStore } from "./attachment-store.js";
import { hostText, setHostLanguage } from "./host-text.js";
import type { IpcSecurity } from "./ipc-security.js";
import { registerSettingsIpcHandlers } from "./settings-ipc-handlers.js";
import { SettingsStore } from "./settings-store.js";

const handled = vi.hoisted(
  () => new Map<string, (...args: unknown[]) => unknown>(),
);

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handled.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handled.delete(channel);
    },
  },
}));

const created: string[] = [];

afterEach(() => {
  setHostLanguage("ko");
  for (const directory of created.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function register(onLanguage: (language: string) => void): () => void {
  const directory = mkdtempSync(path.join(tmpdir(), "gajae-settings-ipc-"));
  created.push(directory);
  const security = {
    guarded: (handler: (...args: unknown[]) => unknown) => handler,
  } as unknown as IpcSecurity;
  return registerSettingsIpcHandlers(
    new SettingsStore(directory, directory),
    {} as AttachmentStore,
    security,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    onLanguage,
  );
}

describe("settings language channel", () => {
  it("redraws host surfaces in the new language once it is saved", async () => {
    // The menu bar was drawn in Korean before the window resolved an English
    // system language, and stayed Korean until some session changed state.
    const seen: string[] = [];
    const dispose = register(() => seen.push(hostText("확인 필요")));
    try {
      await handled.get(SETTINGS_IPC.setLanguage)?.({}, "en");
      expect(seen).toEqual(["Needs input"]);
    } finally {
      dispose();
    }
  });
});
