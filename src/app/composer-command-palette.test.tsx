/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Composer, saveComposerQueue, type ComposerProps } from "./composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(overrides: Partial<ComposerProps> = {}) {
  const sessionId = crypto.randomUUID();
  saveComposerQueue(sessionId, []);
  const send = vi.fn(async () => undefined);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(createElement(Composer, {
    sessionId,
    running: false,
    sessionTitle: "Test",
    workspace: "/repo",
    workspaces: ["/repo"],
    commands: [{ name: "model", description: "Session model profile" }],
    configOptions: [],
    runningSubmission: "queue",
    onSend: send,
    onCancel: vi.fn(async () => undefined),
    onFlushQueued: vi.fn(async () => undefined),
    onCompact: () => {},
    onNewSession: () => {},
    onWorkspaceChange: () => {},
    onConfigChange: () => {},
    onCycleThinking: () => {},
    ...overrides,
  })));
  return {
    node,
    send,
    close: async () => {
      await act(async () => root.unmount());
      node.remove();
      saveComposerQueue(sessionId, []);
    },
  };
}

async function type(node: HTMLElement, text: string): Promise<void> {
  const input = node.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("composer slash palette loading", () => {
  it("requests the live command list once when the palette opens", async () => {
    const onCommandPaletteOpen = vi.fn();
    const test = await mount({ onCommandPaletteOpen });
    try {
      await type(test.node, "/");
      expect(onCommandPaletteOpen).toHaveBeenCalledTimes(1);
      await type(test.node, "/m");
      expect(onCommandPaletteOpen).toHaveBeenCalledTimes(1);
      await type(test.node, "");
      await type(test.node, "/");
      expect(onCommandPaletteOpen).toHaveBeenCalledTimes(2);
    } finally {
      await test.close();
    }
  });

  it("shows the pending load in the palette instead of an empty skill list", async () => {
    const test = await mount({ commandsPending: true });
    try {
      await type(test.node, "/");
      expect(test.node.querySelector(".command-palette")?.textContent).toContain(
        "스킬 불러오는 중",
      );
      // A query that matches no bundled command still opens the palette while
      // skills are loading; otherwise typing a skill name looked like no result.
      await type(test.node, "/skill:whip");
      expect(
        test.node.querySelector(".command-palette-loading")?.textContent,
      ).toContain("스킬 불러오는 중");
    } finally {
      await test.close();
    }
  });

  it("waits for model options instead of sending /model as prompt text", async () => {
    const test = await mount();
    try {
      await type(test.node, "/model");
      const item = [...test.node.querySelectorAll<HTMLButtonElement>(
        ".command-palette-item",
      )].find((button) => button.textContent?.includes("/model"));
      expect(item).toBeDefined();
      await act(async () => item!.click());
      expect(test.send).not.toHaveBeenCalled();
      expect(test.node.textContent).toContain("모델 목록을 불러오는 중");
    } finally {
      await test.close();
    }
  });

  it("labels the model button with the selected profile immediately", async () => {
    const test = await mount({
      commands: [],
      modelDisplay: "Old Model",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "profile-two",
          options: [
            { value: "profile-one", name: "Profile One" },
            { value: "profile-two", name: "Profile Two" },
          ],
        },
      ],
    });
    try {
      expect(
        test.node.querySelector(".composer-model button strong")?.textContent,
      ).toBe("Profile Two");
    } finally {
      await test.close();
    }
  });
});
