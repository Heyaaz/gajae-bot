/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillInvocation } from "./skill-activity";

async function mount(args: string, layout: { scrollHeight: number; clientHeight: number }) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(layout.scrollHeight);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(layout.clientHeight);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(createElement(SkillInvocation, { name: "whip", args })));
  return { node, close: async () => { await act(async () => root.unmount()); node.remove(); } };
}

afterEach(() => vi.restoreAllMocks());

describe("SkillInvocation", () => {
  it("clamps long arguments and unfolds them on request", async () => {
    const test = await mount("Verify only. ".repeat(40), { scrollHeight: 160, clientHeight: 66 });
    try {
      const args = test.node.querySelector(".skill-invocation-args")!;
      const toggle = test.node.querySelector<HTMLButtonElement>(".skill-invocation-heading button")!;
      expect(args.classList.contains("is-clamped")).toBe(true);
      expect(toggle.textContent).toBe("펼치기");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      await act(async () => toggle.click());
      expect(args.classList.contains("is-clamped")).toBe(false);
      expect(toggle.textContent).toBe("접기");
      await act(async () => toggle.click());
      expect(args.classList.contains("is-clamped")).toBe(true);
    } finally {
      await test.close();
    }
  });

  it("offers no toggle when the arguments already fit", async () => {
    const test = await mount("short brief", { scrollHeight: 22, clientHeight: 22 });
    try {
      expect(test.node.querySelector(".skill-invocation-heading button")).toBeNull();
    } finally {
      await test.close();
    }
  });
});
