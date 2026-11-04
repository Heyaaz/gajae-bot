import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_IPC } from "../shared/settings-ipc.js";
import { hostText, setHostLanguage } from "./host-text.js";
import type { IpcSecurity } from "./ipc-security.js";
import { AttachmentStore } from "./attachment-store.js";
import { imageAttachments, registerSettingsIpcHandlers } from "./settings-ipc-handlers.js";
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

const gjcConfig = vi.hoisted(() => ({ applyGjcSettings: vi.fn() }));
vi.mock("./gjc-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gjc-config.js")>()),
  applyGjcSettings: gjcConfig.applyGjcSettings,
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

describe("GJC settings channel", () => {
  function registerWith(
    onApplied: (changes: readonly { key: string; value: boolean | number }[]) => Promise<void>,
  ): () => void {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-settings-ipc-"));
    created.push(directory);
    const security = {
      guarded: (handler: (...args: unknown[]) => unknown) => handler,
      authorizeDestructive: async () => undefined,
    } as unknown as IpcSecurity;
    return registerSettingsIpcHandlers(
      new SettingsStore(directory, directory), {} as AttachmentStore, security,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      onApplied,
    );
  }

  it("hands the applied changes on and returns the listing", async () => {
    const listing = [{ key: "compaction.enabled", type: "boolean", value: false }];
    gjcConfig.applyGjcSettings.mockResolvedValue(listing);
    const onApplied = vi.fn(async () => undefined);
    const dispose = registerWith(onApplied);
    try {
      const changes = [{ key: "compaction.enabled", value: false }];
      await expect(handled.get(SETTINGS_IPC.applyGjcSettings)?.({}, changes)).resolves.toBe(listing);
      expect(onApplied).toHaveBeenCalledWith(changes);
    } finally {
      dispose();
    }
  });

  it("does not hand on changes GJC refused", async () => {
    gjcConfig.applyGjcSettings.mockRejectedValue(new Error("refused"));
    const onApplied = vi.fn(async () => undefined);
    const dispose = registerWith(onApplied);
    try {
      await expect(
        handled.get(SETTINGS_IPC.applyGjcSettings)?.({}, [{ key: "retry.enabled", value: true }]),
      ).rejects.toThrow("refused");
      expect(onApplied).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});

describe("command rules channel", () => {
  const rule = { tool: "bash", prefix: "git status", decision: "allow", createdAt: "2026-11-04T00:00:00.000Z" };
  const store = () => {
    const rules = [{ root: "/repo", rules: [rule] }];
    return {
      list: vi.fn(() => rules.map((project) => ({ ...project }))),
      remove: vi.fn((root: string, prefix: string) => {
        if (root === "/repo" && prefix === "git status") rules.splice(0);
      }),
    };
  };
  function registerRules(commandRules?: ReturnType<typeof store>): () => void {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-settings-ipc-"));
    created.push(directory);
    const security = {
      guarded: (handler: (...args: unknown[]) => unknown) => handler,
    } as unknown as IpcSecurity;
    return registerSettingsIpcHandlers(
      new SettingsStore(directory, directory), {} as AttachmentStore, security,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      commandRules as never,
    );
  }

  it("lists the saved rules and returns what remains after deleting one", async () => {
    const rules = store();
    const dispose = registerRules(rules);
    try {
      expect(await handled.get(SETTINGS_IPC.listCommandRules)?.({})).toEqual([{ root: "/repo", rules: [rule] }]);
      expect(await handled.get(SETTINGS_IPC.removeCommandRule)?.({}, "/repo", "git status")).toEqual([]);
      expect(rules.remove).toHaveBeenCalledWith("/repo", "git status");
    } finally {
      dispose();
    }
  });

  it.each([
    [["", "git status"]],
    [["/repo", ""]],
    [[7, "git status"]],
    [["/repo", null]],
    [["/repo", "x".repeat(201)]],
  ])("refuses to delete with %j", async (args) => {
    const rules = store();
    const dispose = registerRules(rules);
    try {
      expect(() => handled.get(SETTINGS_IPC.removeCommandRule)?.({}, ...args)).toThrow();
      expect(rules.remove).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("offers no channel when the host keeps no rules", () => {
    const dispose = registerRules();
    try {
      expect(handled.has(SETTINGS_IPC.listCommandRules)).toBe(false);
      expect(handled.has(SETTINGS_IPC.removeCommandRule)).toBe(false);
    } finally {
      dispose();
    }
  });
});

describe("imageAttachments", () => {
  it("revokes the tokens already issued when a later image fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-images-"));
    try {
      const good = path.join(directory, "a.png");
      writeFileSync(good, "png");
      const store = new AttachmentStore();
      store.activateSender(7);
      const issue = vi.spyOn(store, "issue");
      const revoke = vi.spyOn(store, "revoke");
      await expect(
        imageAttachments([good, path.join(directory, "missing.png")], store, 7),
      ).rejects.toThrow();
      const issued = await issue.mock.results[0]!.value;
      expect(revoke).toHaveBeenCalledWith(7, [issued.token]);
      await expect(store.acquire(7, [issued.token])).rejects.toThrow("unavailable");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
