/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  QuickInputDesktopBridge,
  ScreenCaptureResult,
} from "../../shared/quick-input";
import { QuickInput } from "./quick-input";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeBridge(captures: ScreenCaptureResult[] = []) {
  let shown: (() => void) | undefined;
  const bridge = {
    state: vi.fn(async () => ({ projects: ["/repo/recent", "/repo/older"] })),
    capture: vi.fn(async () => captures.shift() ?? { outcome: "cancelled" as const }),
    submit: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
    openScreenRecordingSettings: vi.fn(async () => undefined),
    onShown: (listener: () => void) => {
      shown = listener;
      return () => {
        shown = undefined;
      };
    },
  } satisfies QuickInputDesktopBridge;
  return { bridge, show: () => shown?.() };
}

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

async function mount(bridge: QuickInputDesktopBridge) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(QuickInput, { bridge })));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

async function type(host: HTMLElement, text: string) {
  const textarea = host.querySelector("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

async function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

describe("QuickInput", () => {
  it("hands the text, the chosen project and the captures over on Enter", async () => {
    const { bridge } = fakeBridge([
      { outcome: "captured", capture: { id: "c1", name: "capture-1.png", data: "AAAA" } },
    ]);
    const host = await mount(bridge);
    const select = host.querySelector("select")!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["recent", "older"]);
    expect(select.value).toBe("/repo/recent");
    await act(async () => {
      select.value = "/repo/older";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="화면 캡처 첨부"]')!.click());
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("capture-1.png");

    const textarea = await type(host, "  이 오류 고쳐 줘  ");
    await press(textarea, "Enter");
    expect(bridge.submit).toHaveBeenCalledExactlyOnceWith({
      workspace: "/repo/older",
      prompt: "이 오류 고쳐 줘",
      captureIds: ["c1"],
    });
    expect(textarea.value).toBe("");
    expect(host.querySelector("img")).toBeNull();
  });

  it("does not submit on the Enter that confirms an IME composition or on Shift+Enter", async () => {
    const { bridge } = fakeBridge();
    const host = await mount(bridge);
    const textarea = await type(host, "한글");
    await press(textarea, "Enter", { isComposing: true });
    await press(textarea, "Enter", { shiftKey: true });
    expect(bridge.submit).not.toHaveBeenCalled();
    await press(textarea, "Escape");
    expect(bridge.dismiss).toHaveBeenCalledOnce();
  });

  it("explains a denied Screen Recording permission and links to the setting", async () => {
    const { bridge } = fakeBridge([{ outcome: "permission-denied" }]);
    const host = await mount(bridge);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="화면 캡처 첨부"]')!.click());
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("화면 기록");
    await act(async () => alert!.querySelector("button")!.click());
    expect(bridge.openScreenRecordingSettings).toHaveBeenCalledOnce();
  });

  it("reloads the project list each time the window is shown", async () => {
    const { bridge, show } = fakeBridge();
    await mount(bridge);
    expect(bridge.state).toHaveBeenCalledTimes(1);
    await act(async () => show());
    expect(bridge.state).toHaveBeenCalledTimes(2);
  });
});
