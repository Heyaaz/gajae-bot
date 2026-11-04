/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SKILL_ARGS_VIEW, SkillInvocation, type SkillArgsView } from "./skill-activity";

const LONG = "Verify only. ".repeat(40);

/** `long` makes the arguments take several lines whether clamped or not. */
function layout(long: boolean) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(long ? 160 : 20);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("is-clamped")) return 20;
    return long ? 160 : 20;
  });
}

async function mount(initialView: SkillArgsView, args = LONG) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const render = (view: SkillArgsView) =>
    act(async () => root.render(createElement(SkillInvocation, { name: "whip", args, initialView: view })));
  await render(initialView);
  return {
    args: () => node.querySelector(".skill-invocation-args"),
    toggle: () => node.querySelector<HTMLButtonElement>(".skill-invocation-heading button"),
    rerender: render,
    close: async () => { await act(async () => root.unmount()); node.remove(); },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("SkillInvocation", () => {
  it("maps 요약, 기본 and 상세 to hidden, one line and full", () => {
    expect(SKILL_ARGS_VIEW).toEqual({ basic: "hidden", reasoning: "line", detailed: "full" });
  });

  it("hides the arguments under 요약 until unfolded", async () => {
    layout(true);
    const test = await mount("hidden");
    try {
      expect(test.args()).toBeNull();
      expect(test.toggle()?.textContent).toBe("펼치기");
      await act(async () => test.toggle()!.click());
      expect(test.args()?.classList.contains("is-clamped")).toBe(false);
      await act(async () => test.toggle()!.click());
      expect(test.args()).toBeNull();
    } finally {
      await test.close();
    }
  });

  it("shows one line under 기본 and unfolds a long one", async () => {
    layout(true);
    const test = await mount("line");
    try {
      expect(test.args()?.classList.contains("is-clamped")).toBe(true);
      expect(test.toggle()?.getAttribute("aria-expanded")).toBe("false");
      await act(async () => test.toggle()!.click());
      expect(test.args()?.classList.contains("is-clamped")).toBe(false);
      expect(test.toggle()?.textContent).toBe("접기");
    } finally {
      await test.close();
    }
  });

  it("starts unfolded under 상세 and folds to one line", async () => {
    layout(true);
    const test = await mount("full");
    try {
      expect(test.args()?.classList.contains("is-clamped")).toBe(false);
      await act(async () => test.toggle()!.click());
      expect(test.args()?.classList.contains("is-clamped")).toBe(true);
    } finally {
      await test.close();
    }
  });

  it("returns to the new mode's view when the mode changes", async () => {
    layout(true);
    const test = await mount("line");
    try {
      await act(async () => test.toggle()!.click());
      expect(test.args()?.classList.contains("is-clamped")).toBe(false);
      await test.rerender("hidden");
      expect(test.args()).toBeNull();
      await test.rerender("line");
      expect(test.args()?.classList.contains("is-clamped")).toBe(true);
    } finally {
      await test.close();
    }
  });

  it("offers no toggle for a one-line request outside 요약", async () => {
    layout(false);
    const test = await mount("line", "short brief");
    try {
      expect(test.toggle()).toBeNull();
      await test.rerender("full");
      expect(test.toggle()).toBeNull();
    } finally {
      await test.close();
    }
  });
});
