/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateStatus } from "../../shared/app-update";
import { setLanguageMode } from "../i18n";
import { AppUpdateRow } from "./app-update-row";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  setLanguageMode("ko");
  vi.restoreAllMocks();
});

async function render(bridge: {
  getAppUpdateStatus: () => Promise<AppUpdateStatus>;
  checkAppUpdate: () => Promise<AppUpdateStatus>;
}): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(AppUpdateRow, { bridge }));
  });
  return container;
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
}

describe("AppUpdateRow", () => {
  it("shows a release it cannot read as a quiet cannot-check line", async () => {
    const container = await render({
      getAppUpdateStatus: async () => ({ state: "unchecked", currentVersion: "0.1.0" }),
      checkAppUpdate: async () => ({
        state: "unknown",
        currentVersion: "0.1.0",
        reason: "not-found",
        checkedAtMs: 1,
      }),
    });
    expect(container.textContent).toContain("0.1.0 · 아직 확인하지 않았습니다");
    await act(async () => button(container, "지금 확인")!.click());
    expect(container.textContent).toContain("0.1.0 · 확인할 수 없음");
    expect(button(container, "릴리스 페이지")).toBeUndefined();
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("links a newer release to its page", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const container = await render({
      getAppUpdateStatus: async () => ({
        state: "available",
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        releaseUrl: "https://github.com/Heyaaz/gajae-bot/releases/tag/v0.2.0",
        checkedAtMs: 1,
      }),
      checkAppUpdate: async () => {
        throw new Error("not used");
      },
    });
    expect(container.textContent).toContain("0.1.0 → 0.2.0 사용 가능");
    act(() => button(container, "릴리스 페이지")!.click());
    expect(open).toHaveBeenCalledWith(
      "https://github.com/Heyaaz/gajae-bot/releases/tag/v0.2.0",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("keeps the last status when the check itself is refused", async () => {
    setLanguageMode("en");
    const container = await render({
      getAppUpdateStatus: async () => ({
        state: "current",
        currentVersion: "0.1.0",
        latestVersion: "0.1.0",
        checkedAtMs: 1,
      }),
      checkAppUpdate: async () => {
        throw new Error("No handler registered");
      },
    });
    await act(async () => button(container, "Check now")!.click());
    expect(container.textContent).toContain("Latest version 0.1.0");
    expect(button(container, "Check now")?.disabled).toBe(false);
  });
});
