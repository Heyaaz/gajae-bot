/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../../shared/agent-contract";
import { DEFAULT_DESKTOP_INTEGRATION } from "../../shared/desktop-integration";
import type { AgentControlPreferences } from "../backend/types";
import { setLanguageMode } from "../i18n";
import { SettingsDialog } from "./settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(() => {
  setLanguageMode("ko");
});

const loaded: AgentControlPreferences = {
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
} as AgentControlPreferences;

const bridge = window as unknown as { agentControlDesktop?: unknown };

async function mount(onClose: () => void) {
  bridge.agentControlDesktop = {
    settings: {
      getPreferences: async () => loaded,
      listCommandRules: async () => [],
      removeCommandRule: async () => [],
      getAppUpdateStatus: async () => ({ state: "unchecked", currentVersion: "0.1.0" }),
      checkAppUpdate: async () => ({ state: "unchecked", currentVersion: "0.1.0" }),
      quickInputShortcutStatus: async () => ({ state: "registered", accelerator: "Control+Alt+Space" }),
    },
  };
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(SettingsDialog, {
        connection: { state: "connected", backend: "gjc", label: "GJC", detail: "", workspace: "/tmp" },
        thoughtsExpanded: false,
        onToggleThoughtsExpanded: () => undefined,
        onClose,
        onSaved: () => undefined,
        updateStatus: null,
        updateBusy: null,
        updateError: "",
        onCheckUpdate: () => undefined,
        onInstallUpdate: () => undefined,
      }),
    );
  });
  return {
    host,
    root,
    opener,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
      opener.remove();
      delete bridge.agentControlDesktop;
    },
  };
}

function press(target: Element, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("settings Escape", () => {
  it("closes from a focused input and consumes the key so the run is not stopped", async () => {
    const onClose = vi.fn();
    const view = await mount(onClose);
    try {
      const input = view.host.querySelector("input")!;
      input.focus();
      const event = press(input);
      expect(onClose).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("closes an open dropdown first and the dialog on the next press", async () => {
    const onClose = vi.fn();
    const view = await mount(onClose);
    try {
      const trigger = view.host.querySelector<HTMLButtonElement>("button[aria-haspopup=listbox]")!;
      await act(async () => trigger.click());
      expect(view.host.querySelector("[role=listbox]")).not.toBeNull();
      press(trigger);
      expect(view.host.querySelector("[role=listbox]")).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      press(trigger);
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });

  it("ignores Escape that cancels IME composition or was already handled", async () => {
    const onClose = vi.fn();
    const view = await mount(onClose);
    try {
      press(document.body, { isComposing: true });
      press(document.body, { keyCode: 229 });
      const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      handled.preventDefault();
      act(() => {
        document.body.dispatchEvent(handled);
      });
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it("returns focus to the element that opened settings", async () => {
    const view = await mount(() => undefined);
    try {
      view.host.querySelector("input")?.focus();
      expect(document.activeElement).not.toBe(view.opener);
      const { opener } = view;
      act(() => view.root.unmount());
      expect(document.activeElement).toBe(opener);
    } finally {
      view.unmount();
    }
  });
});
