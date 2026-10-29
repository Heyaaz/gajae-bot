/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../../shared/agent-contract";
import { DEFAULT_DESKTOP_INTEGRATION } from "../../shared/desktop-integration";
import type { QuickInputShortcutStatus } from "../../shared/quick-input";
import type { AgentControlPreferences } from "../backend/types";
import { setLanguageMode } from "../i18n";
import {
  canSavePreferences,
  mergeInitialPreferences,
  resolvePreferenceSave,
  SettingsDialog,
  settingsErrorMessage,
} from "./settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(() => {
  setLanguageMode("ko");
  vi.unstubAllGlobals();
});

const fallback: AgentControlPreferences = {
  workspace: "/fallback",
  workspaceLabel: "개인 Workspace",
  modelPreset: "codex-medium",
  permissionHandling: "prompt",
  gjcExecutable: "",
  thoughtsExpanded: false,
  toolViewMode: "reasoning",
  notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
  desktopIntegration: DEFAULT_DESKTOP_INTEGRATION,
  language: "ko",
  runningSubmission: "queue",
};

const loaded: AgentControlPreferences = {
  ...fallback,
  workspace: "/loaded",
  modelPreset: "codex-pro",
  gjcExecutable: "/opt/gjc",
  permissionHandling: "always-allow",
};

describe("settings preference loading", () => {
  it("keeps only the fields edited while the initial read was pending", () => {
    const edited = { ...fallback, modelPreset: "custom-profile" };

    expect(mergeInitialPreferences(edited, loaded, ["modelPreset"])).toEqual({
      // The stored workspace, executable and permission mode survive an edit to
      // an unrelated field instead of being replaced by the fallback draft.
      preferences: { ...loaded, modelPreset: "custom-profile" },
      original: loaded,
    });
  });

  it("merges several edited fields over the loaded preferences", () => {
    const edited = {
      ...fallback,
      workspace: "/picked",
      thoughtsExpanded: true,
    };
    expect(
      mergeInitialPreferences(edited, loaded, ["workspace", "thoughtsExpanded"]),
    ).toEqual({
      preferences: {
        ...loaded,
        workspace: "/picked",
        thoughtsExpanded: true,
      },
      original: loaded,
    });
  });

  it("uses the loaded preferences when no edit preceded the response", () => {
    expect(mergeInitialPreferences(fallback, loaded, [])).toEqual({
      preferences: loaded,
      original: loaded,
    });
  });
});

describe("settings save gate", () => {
  it("does not save before the initial read succeeds", () => {
    // A failed or pending read leaves the draft on fallback values; saving it
    // would overwrite every stored setting the user did not touch.
    expect(canSavePreferences(true, false, true, false)).toBe(false);
    expect(canSavePreferences(true, false, true, true)).toBe(true);
  });

  it("still requires a change, an idle save, and a bridge", () => {
    expect(canSavePreferences(false, false, true, true)).toBe(false);
    expect(canSavePreferences(true, true, true, true)).toBe(false);
    expect(canSavePreferences(true, false, false, true)).toBe(false);
  });
});

describe("settings save completion", () => {
  const saved: AgentControlPreferences = {
    ...loaded,
    modelPreset: "saved-profile",
    gjcExecutable: "",
  };
  const newer: AgentControlPreferences = {
    ...loaded,
    modelPreset: "edited-while-saving",
  };

  it("adopts the saved values and closes only for the same draft", () => {
    expect(
      resolvePreferenceSave({
        mounted: true,
        revisionAtSave: 3,
        revisionNow: 3,
        current: loaded,
        saved,
      }),
    ).toEqual({
      notify: true,
      close: true,
      preferences: saved,
      original: saved,
    });
  });

  it("keeps an edit made while the save was pending and stays open", () => {
    expect(
      resolvePreferenceSave({
        mounted: true,
        revisionAtSave: 3,
        revisionNow: 4,
        current: newer,
        saved,
      }),
    ).toEqual({
      notify: true,
      close: false,
      preferences: newer,
      original: saved,
    });
  });

  it("lets no response from an unmounted dialog touch the active one", () => {
    expect(
      resolvePreferenceSave({
        mounted: false,
        revisionAtSave: 7,
        revisionNow: 7,
        current: newer,
        saved,
      }),
    ).toEqual({
      notify: false,
      close: false,
      preferences: newer,
      original: newer,
    });
  });
});

describe("settings dialog language", () => {
  it("renders its navigation and appearance controls in English", () => {
    setLanguageMode("en");
    vi.stubGlobal("window", { agentControlDesktop: undefined });
    const markup = renderToStaticMarkup(
      createElement(SettingsDialog, {
        connection: {
          state: "connected",
          backend: "gjc",
          label: "GJC",
          detail: "",
          workspace: "/tmp",
        },
        thoughtsExpanded: false,
        onClose: () => undefined,
        onSaved: () => undefined,
        updateStatus: null,
        updateBusy: null,
        updateError: "",
        onCheckUpdate: () => undefined,
        onInstallUpdate: () => undefined,
      }),
    );
    expect(markup).toContain("Appearance");
    expect(markup).toContain("Notifications");
    expect(markup).toContain("Save");
    expect(markup).not.toContain("모양");
  });
});

describe("settings errors", () => {
  it("preserves useful Error messages and renders non-Error rejections", () => {
    expect(settingsErrorMessage(new Error("disk unavailable"))).toBe(
      "disk unavailable",
    );
    expect(settingsErrorMessage("IPC rejected")).toBe("IPC rejected");
  });
});

describe("settings desktop tab", () => {
  it("saves each desktop toggle on its own without touching the others", async () => {
    const setDesktopIntegration = vi.fn(
      async (value: AgentControlPreferences["desktopIntegration"]) => value,
    );
    const bridge = window as unknown as { agentControlDesktop?: unknown };
    bridge.agentControlDesktop = {
      settings: {
        getPreferences: async () => loaded,
        setDesktopIntegration,
        getAppUpdateStatus: async () => ({ state: "unchecked", currentVersion: "0.1.0" }),
        checkAppUpdate: async () => ({ state: "unchecked", currentVersion: "0.1.0" }),
        quickInputShortcutStatus: async () => ({ state: "registered", accelerator: "Control+Alt+Space" }),
      },
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          createElement(SettingsDialog, {
            connection: {
              state: "connected",
              backend: "gjc",
              label: "GJC",
              detail: "",
              workspace: "/tmp",
            },
            thoughtsExpanded: false,
            onClose: () => undefined,
            onSaved: () => undefined,
            updateStatus: null,
            updateBusy: null,
            updateError: "",
            onCheckUpdate: () => undefined,
            onInstallUpdate: () => undefined,
          }),
        );
      });
      const desktopTab = [...host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "데스크톱",
      );
      await act(async () => desktopTab?.click());
      const toggle = (label: string) =>
        host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
      expect(toggle("메뉴바 상태 표시")?.checked).toBe(true);
      expect(toggle("Dock 배지")?.checked).toBe(true);

      await act(async () => toggle("메뉴바 상태 표시")?.click());
      expect(setDesktopIntegration).toHaveBeenLastCalledWith({
        ...DEFAULT_DESKTOP_INTEGRATION,
        menuBarStatus: false,
      });
      await act(async () => toggle("Dock 배지")?.click());
      expect(setDesktopIntegration).toHaveBeenLastCalledWith({
        ...DEFAULT_DESKTOP_INTEGRATION,
        menuBarStatus: false,
        dockBadge: false,
      });
      expect(toggle("메뉴바 상태 표시")?.checked).toBe(false);
      await act(async () => toggle("Gajae 업데이트 확인")?.click());
      expect(setDesktopIntegration).toHaveBeenLastCalledWith({
        ...DEFAULT_DESKTOP_INTEGRATION,
        menuBarStatus: false,
        dockBadge: false,
        checkAppUpdates: false,
      });
    } finally {
      act(() => root.unmount());
      host.remove();
      delete bridge.agentControlDesktop;
    }
  });

  it("turns the quick input shortcut off and on, and shows a registration failure", async () => {
    let status: QuickInputShortcutStatus = {
      state: "registered",
      accelerator: "Control+Alt+Space",
    };
    const setDesktopIntegration = vi.fn(
      async (value: AgentControlPreferences["desktopIntegration"]) => {
        status = !value.quickInputShortcut
          ? { state: "off" }
          : value.quickInputShortcut === "Command+Space"
            ? { state: "failed", accelerator: "Command+Space", reason: "unavailable" }
            : { state: "registered", accelerator: value.quickInputShortcut };
        return value;
      },
    );
    const bridge = window as unknown as { agentControlDesktop?: unknown };
    bridge.agentControlDesktop = {
      settings: {
        getPreferences: async () => loaded,
        setDesktopIntegration,
        getAppUpdateStatus: async () => ({ state: "unchecked", currentVersion: "0.1.0" }),
        checkAppUpdate: async () => ({ state: "unchecked", currentVersion: "0.1.0" }),
        quickInputShortcutStatus: async () => status,
      },
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          createElement(SettingsDialog, {
            connection: {
              state: "connected",
              backend: "gjc",
              label: "GJC",
              detail: "",
              workspace: "/tmp",
            },
            thoughtsExpanded: false,
            onClose: () => undefined,
            onSaved: () => undefined,
            updateStatus: null,
            updateBusy: null,
            updateError: "",
            onCheckUpdate: () => undefined,
            onInstallUpdate: () => undefined,
          }),
        );
      });
      const desktopTab = [...host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "데스크톱",
      );
      await act(async () => desktopTab?.click());
      const row = () => host.querySelector(".quick-input-shortcut-row");
      const toggle = () =>
        host.querySelector<HTMLInputElement>('input[aria-label="빠른 입력 단축키"]');
      const field = () =>
        host.querySelector<HTMLInputElement>('input[aria-label="단축키"]');
      expect(toggle()?.checked).toBe(true);
      expect(field()?.value).toBe("Control+Alt+Space");
      expect(row()?.textContent).toContain("Control+Alt+Space 등록됨");

      await act(async () => toggle()?.click());
      expect(setDesktopIntegration).toHaveBeenLastCalledWith({
        ...DEFAULT_DESKTOP_INTEGRATION,
        quickInputShortcut: "",
      });
      expect(field()).toBeNull();
      expect(row()?.textContent).toContain("꺼져 있습니다.");

      await act(async () => toggle()?.click());
      const input = field();
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        input?.focus();
        setValue?.call(input, "Command+Space");
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => input?.blur());
      expect(setDesktopIntegration).toHaveBeenLastCalledWith({
        ...DEFAULT_DESKTOP_INTEGRATION,
        quickInputShortcut: "Command+Space",
      });
      expect(host.querySelector('.quick-input-shortcut-row [role="alert"]')?.textContent).toContain(
        "Command+Space을(를) 등록하지 못했습니다",
      );
    } finally {
      act(() => root.unmount());
      host.remove();
      delete bridge.agentControlDesktop;
    }
  });
});
