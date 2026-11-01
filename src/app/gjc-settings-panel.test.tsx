/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GjcSetting, GjcSettingChange } from "../../shared/gjc-settings";
import { GjcSettingsPanel } from "./gjc-settings-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const SETTINGS: GjcSetting[] = [
  { key: "retry.enabled", type: "boolean", value: true, description: "Retry failed requests" },
  { key: "retry.maxRetries", type: "number", value: 3 },
  { key: "power.preventIdleSleep", type: "boolean", value: null },
];

async function renderPanel(bridge: {
  listGjcSettings(): Promise<GjcSetting[]>;
  applyGjcSettings(changes: GjcSettingChange[]): Promise<GjcSetting[]>;
}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(GjcSettingsPanel, { bridge }));
  });
  return container;
}

function setNumber(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("GjcSettingsPanel", () => {
  it("groups settings by their first key segment and marks unset values", async () => {
    const container = await renderPanel({
      listGjcSettings: async () => SETTINGS,
      applyGjcSettings: vi.fn(),
    });
    expect([...container.querySelectorAll(".gjc-settings-group h3")].map((h) => h.textContent))
      .toEqual(["retry", "power"]);
    expect(container.querySelector(".gjc-settings-group em")?.textContent).toBe("기본값");
  });

  it("applies staged edits as one batch and shows the returned values", async () => {
    const apply = vi.fn(async (changes: GjcSettingChange[]) =>
      SETTINGS.map((setting) => {
        const change = changes.find((entry) => entry.key === setting.key);
        return change ? { ...setting, value: change.value } : setting;
      }),
    );
    const container = await renderPanel({ listGjcSettings: async () => SETTINGS, applyGjcSettings: apply });
    const toggle = container.querySelector<HTMLInputElement>('input[aria-label="retry.enabled"]')!;
    const retries = container.querySelector<HTMLInputElement>('input[aria-label="retry.maxRetries"]')!;
    await act(async () => {
      toggle.click();
      setNumber(retries, "5");
    });
    expect(container.querySelector(".gjc-settings-apply span")?.textContent).toBe("바꾼 설정 2개");
    const applyButton = [...container.querySelectorAll<HTMLButtonElement>(".gjc-settings-apply button")]
      .find((button) => button.textContent === "적용")!;
    await act(async () => applyButton.click());
    expect(apply).toHaveBeenCalledWith([
      { key: "retry.enabled", value: false },
      { key: "retry.maxRetries", value: 5 },
    ]);
    expect(container.querySelector(".gjc-settings-apply")).toBeNull();
    expect(toggle.checked).toBe(false);
  });

  it("drops an edit that returns to the saved value", async () => {
    const container = await renderPanel({ listGjcSettings: async () => SETTINGS, applyGjcSettings: vi.fn() });
    const toggle = container.querySelector<HTMLInputElement>('input[aria-label="retry.enabled"]')!;
    await act(async () => toggle.click());
    expect(container.querySelector(".gjc-settings-apply")).not.toBeNull();
    await act(async () => toggle.click());
    expect(container.querySelector(".gjc-settings-apply")).toBeNull();
  });

  it("keeps the edits without an error when the confirmation is cancelled", async () => {
    const container = await renderPanel({
      listGjcSettings: async () => SETTINGS,
      applyGjcSettings: async () => {
        throw new Error("Error invoking remote method: Error: Operation cancelled");
      },
    });
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="retry.enabled"]')!.click());
    const applyButton = [...container.querySelectorAll<HTMLButtonElement>(".gjc-settings-apply button")]
      .find((button) => button.textContent === "적용")!;
    await act(async () => applyButton.click());
    expect(container.querySelector(".gjc-settings-apply")).not.toBeNull();
    expect(container.textContent).not.toContain("저장하지 못했습니다");
  });

  it("filters by key or description", async () => {
    const container = await renderPanel({ listGjcSettings: async () => SETTINGS, applyGjcSettings: vi.fn() });
    await act(async () => setNumber(container.querySelector<HTMLInputElement>('input[type="search"]')!, "failed"));
    expect([...container.querySelectorAll(".gjc-settings-group code")].map((code) => code.textContent))
      .toEqual(["retry.enabled"]);
  });
});
