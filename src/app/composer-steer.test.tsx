/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  Composer,
  composerQueue,
  prefillComposerDraft,
  publishComposerDraftRecovery,
  saveComposerQueue,
  type ComposerProps,
} from "./composer";

async function mount(overrides: Partial<ComposerProps> = {}) {
  const sessionId = crypto.randomUUID();
  saveComposerQueue(sessionId, [
    { id: "first", text: "change direction", mode: "followUp", label: "Queued", images: [], files: [] },
    { id: "second", text: "keep waiting", mode: "followUp", label: "Queued", images: [], files: [] },
  ]);
  const send = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  const flush = vi.fn(async () => undefined);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(createElement(Composer, {
    sessionId, running: true, sessionTitle: "Test", workspace: "/repo", workspaces: ["/repo"],
    commands: [], configOptions: [], runningSubmission: "queue", onSend: send,
    onCancel: cancel, onFlushQueued: flush, onCompact: () => {}, onNewSession: () => {},
    onWorkspaceChange: () => {}, onConfigChange: () => {}, onCycleThinking: () => {}, ...overrides,
  })));
  return { node, send, cancel, flush, sessionId, close: async () => {
    await act(async () => root.unmount()); node.remove(); saveComposerQueue(sessionId, []);
  } };
}

describe("queued message Send now", () => {
  it.each([
    { text: "/steer change course", preference: "queue" as const, mode: "steer", expected: "change course" },
    { text: "change course", preference: "steer" as const, mode: "steer", expected: "change course" },
    { text: "/queue wait for me", preference: "steer" as const, mode: "followUp", expected: "wait for me" },
  ])("shows submitted $text above the input without sending it", async ({ text, preference, mode, expected }) => {
    const test = await mount({ runningSubmission: preference });
    try {
      await act(async () => saveComposerQueue(test.sessionId, []));
      const input = test.node.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(test.send).not.toHaveBeenCalled();
      expect(composerQueue(test.sessionId)).toEqual([
        expect.objectContaining({ text: expected, mode }),
      ]);
      expect(test.node.querySelector(".composer-queue-text")?.textContent).toBe(expected);
      const queue = test.node.querySelector(".composer-queue")!;
      expect(queue.closest("form")).toBeNull();
      expect(queue.nextElementSibling).toBe(test.node.querySelector("form.composer"));
      expect(queue.querySelector("strong, small, em")).toBeNull();
      expect(test.node.querySelector(".composer-queue-send")).not.toBeNull();
      expect(input.value).toBe("");
      await act(async () => (test.node.querySelector(".composer-queue-send") as HTMLButtonElement).click());
      expect(test.send).toHaveBeenCalledExactlyOnceWith({ text: `/steer ${expected}`, images: [], files: [] });
    } finally { await test.close(); }
  });

  it("keeps the row until acceptance, steers only that entry, and never stops the turn", async () => {
    let accept!: () => void;
    const send = vi.fn(() => new Promise<undefined>((resolve) => { accept = () => resolve(undefined); }));
    const test = await mount({ onSend: send });
    try {
      await act(async () => (test.node.querySelector(".composer-queue-send") as HTMLButtonElement).click());
      expect(send).toHaveBeenCalledExactlyOnceWith({ text: "/steer change direction", images: [], files: [] });
      expect(composerQueue(test.sessionId)).toHaveLength(2);
      expect(test.cancel).not.toHaveBeenCalled();
      expect(test.flush).not.toHaveBeenCalled();
      await act(async () => accept());
      expect(composerQueue(test.sessionId).map((row) => row.id)).toEqual(["second"]);
      expect(test.node.querySelector(".composer-queue-items")?.textContent).not.toContain("change direction");
    } finally { await test.close(); }
  });

  it("retains a failed send for review rather than automatically retrying it", async () => {
    const test = await mount({ onSend: async () => { throw new Error("unknown delivery"); } });
    try {
      await act(async () => (test.node.querySelector(".composer-queue-send") as HTMLButtonElement).click());
      expect(composerQueue(test.sessionId)[0]).toMatchObject({ id: "first", blocked: true });
      expect((test.node.querySelector(".composer-queue-send") as HTMLButtonElement).disabled).toBe(true);
      expect(test.node.textContent).toContain("change direction");
    } finally { await test.close(); }
  });

  it("disables every queued action for read-only clients", async () => {
    const test = await mount({ readOnly: true });
    try {
      const buttons = [...test.node.querySelectorAll<HTMLButtonElement>(".composer-queue-item button")];
      expect(buttons.length).toBe(8);
      expect(buttons.every((button) => button.disabled)).toBe(true);
      expect(test.send).not.toHaveBeenCalled();
    } finally { await test.close(); }
  });

  it("sends a normal prompt when the turn has already ended", async () => {
    const test = await mount({ running: false });
    try {
      await act(async () => (test.node.querySelector(".composer-queue-send") as HTMLButtonElement).click());
      expect(test.send).toHaveBeenCalledExactlyOnceWith({ text: "change direction", images: [], files: [] });
      expect(test.flush).not.toHaveBeenCalled();
    } finally { await test.close(); }
  });
});

describe("composer draft prefill", () => {
  const notice = "전송 결과를 확인할 수 없습니다";

  async function type(node: HTMLElement, text: string): Promise<HTMLTextAreaElement> {
    const input = node.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  }

  it("merges a prefill into the mounted draft without sending it or warning", async () => {
    const test = await mount({ running: false });
    try {
      const input = await type(test.node, "already typed");
      await act(async () => prefillComposerDraft(test.sessionId, "issue body"));
      expect(input.value).toBe("issue body\nalready typed");
      expect(test.node.querySelector(".composer-error")).toBeNull();
      expect(test.send).not.toHaveBeenCalled();
    } finally { await test.close(); }
  });

  it("waits for a composer that mounts after the prefill", async () => {
    const sessionId = crypto.randomUUID();
    prefillComposerDraft(sessionId, "deep link prompt");
    const test = await mount({ sessionId, running: false });
    try {
      expect(test.node.querySelector("textarea")!.value).toBe("deep link prompt");
      expect(test.node.querySelector(".composer-error")).toBeNull();
      expect(test.send).not.toHaveBeenCalled();
    } finally { await test.close(); }
  });

  it("still warns when the recovered text is a rejected send", async () => {
    const test = await mount({ running: false });
    try {
      await act(async () =>
        publishComposerDraftRecovery(test.sessionId, { text: "lost request", images: [], files: [] }),
      );
      expect(test.node.querySelector("textarea")!.value).toBe("lost request");
      expect(test.node.querySelector(".composer-error")?.textContent).toContain(notice);
    } finally { await test.close(); }
  });
});
