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
import { submitComposerInput } from "./composer-session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function type(input: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter(input: HTMLTextAreaElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  await act(async () => { input.dispatchEvent(event); });
  return event;
}

async function nextFrame() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
}

describe("running composer Enter", () => {
  it.each(["queue", "steer"] as const)("applies the %s preference to an actual keydown", async (preference) => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const test = await mount({ runningSubmission: preference });
    try {
      await act(async () => saveComposerQueue(test.sessionId, []));
      const input = test.node.querySelector("textarea")!;
      input.focus();
      await type(input, "change course");
      expect((await pressEnter(input)).defaultPrevented).toBe(true);
      expect(input.value).toBe("");
      expect(test.cancel).not.toHaveBeenCalled();
      expect(test.flush).not.toHaveBeenCalled();
      if (preference === "queue") {
        expect(test.send).not.toHaveBeenCalled();
        expect(composerQueue(test.sessionId)).toEqual([
          expect.objectContaining({ text: "change course", mode: "followUp" }),
        ]);
      } else {
        expect(test.send).toHaveBeenCalledExactlyOnceWith({ text: "/steer change course", images: [], files: [] });
        expect(composerQueue(test.sessionId)).toEqual([]);
      }
    } finally { await test.close(); clock.mockRestore(); }
  });

  it("keeps a plain Enter behind an existing queue under the steer preference", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const test = await mount({ runningSubmission: "steer" });
    try {
      const input = test.node.querySelector("textarea")!;
      await type(input, "after those");
      await pressEnter(input);
      expect(composerQueue(test.sessionId).map((entry) => entry.text)).toEqual([
        "change direction", "keep waiting", "after those",
      ]);
      expect(test.send).not.toHaveBeenCalled();
      expect(test.flush).not.toHaveBeenCalled();
      expect(test.cancel).not.toHaveBeenCalled();
    } finally { await test.close(); clock.mockRestore(); }
  });

  it("releases the queued draft on a blank second Enter through flush, not cancel", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const test = await mount();
    try {
      await act(async () => saveComposerQueue(test.sessionId, []));
      const input = test.node.querySelector("textarea")!;
      input.focus();
      await type(input, "change course");
      await pressEnter(input);
      await nextFrame();
      expect(document.activeElement).toBe(input);
      expect(composerQueue(test.sessionId)).toHaveLength(1);
      expect((await pressEnter(input)).defaultPrevented).toBe(true);
      expect(test.flush).toHaveBeenCalledTimes(1);
      expect(test.send).toHaveBeenCalledExactlyOnceWith({ text: "change course", images: [], files: [] });
      expect(test.flush.mock.invocationCallOrder[0]).toBeLessThan(test.send.mock.invocationCallOrder[0]!);
      expect(test.cancel).not.toHaveBeenCalled();
      expect(composerQueue(test.sessionId)).toEqual([]);
    } finally { await test.close(); clock.mockRestore(); }
  });

  it("restores textarea focus after submitting with the send button", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const test = await mount();
    try {
      await act(async () => saveComposerQueue(test.sessionId, []));
      const input = test.node.querySelector("textarea")!;
      await type(input, "change course");
      const button = test.node.querySelector<HTMLButtonElement>("button[type=submit]")!;
      button.focus();
      await act(async () => button.click());
      await nextFrame();
      expect(document.activeElement).toBe(input);
      expect(composerQueue(test.sessionId)).toHaveLength(1);
      await pressEnter(input);
      expect(test.flush).toHaveBeenCalledTimes(1);
      expect(test.send).toHaveBeenCalledExactlyOnceWith({ text: "change course", images: [], files: [] });
      expect(test.cancel).not.toHaveBeenCalled();
    } finally { await test.close(); clock.mockRestore(); }
  });

  it("keeps queued work blocked when the flush rejects", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const flush = vi.fn(async () => { throw new Error("flush failed"); });
    const test = await mount({ onFlushQueued: flush });
    try {
      const input = test.node.querySelector("textarea")!;
      await pressEnter(input);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(test.send).not.toHaveBeenCalled();
      expect(test.cancel).not.toHaveBeenCalled();
      expect(composerQueue(test.sessionId)[0]).toMatchObject({ id: "first", blocked: true });
      expect(test.node.querySelector(".composer-error")?.textContent).toContain("flush failed");
    } finally { await test.close(); clock.mockRestore(); }
  });

  it("keeps an IME follow-up from submitting twice or releasing the queue", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const test = await mount();
    try {
      await act(async () => saveComposerQueue(test.sessionId, []));
      const input = test.node.querySelector("textarea")!;
      input.focus();
      await act(async () => { input.dispatchEvent(new Event("compositionstart", { bubbles: true })); });
      await type(input, "변경해 주세요");
      expect((await pressEnter(input, { isComposing: true })).defaultPrevented).toBe(true);
      await act(async () => { input.dispatchEvent(new Event("compositionend", { bubbles: true })); });
      await pressEnter(input);
      await nextFrame();
      expect(composerQueue(test.sessionId)).toEqual([
        expect.objectContaining({ text: "변경해 주세요", mode: "followUp" }),
      ]);
      expect(input.value).toBe("");
      expect(test.send).not.toHaveBeenCalled();
      expect(test.flush).not.toHaveBeenCalled();
      expect(test.cancel).not.toHaveBeenCalled();

      // The current follow-up window also consumes a blank keydown after the frame.
      expect((await pressEnter(input)).defaultPrevented).toBe(true);
      expect(test.flush).not.toHaveBeenCalled();
      clock.mockReturnValue(10_101);
      await pressEnter(input);
      expect(test.flush).toHaveBeenCalledTimes(1);
      expect(test.send).toHaveBeenCalledExactlyOnceWith({ text: "변경해 주세요", images: [], files: [] });
      expect(composerQueue(test.sessionId)).toEqual([]);
    } finally { await test.close(); clock.mockRestore(); }
  });

  it("leaves Shift+Enter to the textarea without sending or releasing", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const test = await mount();
    try {
      const input = test.node.querySelector("textarea")!;
      await type(input, "still editing");
      expect((await pressEnter(input, { shiftKey: true })).defaultPrevented).toBe(false);
      expect(input.value).toBe("still editing");
      expect(composerQueue(test.sessionId)).toHaveLength(2);
      expect(test.send).not.toHaveBeenCalled();
      expect(test.flush).not.toHaveBeenCalled();
      expect(test.cancel).not.toHaveBeenCalled();
    } finally { await test.close(); clock.mockRestore(); }
  });
});

describe("queued message Send now", () => {
  async function submit(test: Awaited<ReturnType<typeof mount>>, text: string) {
    const input = test.node.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    return input;
  }

  it.each([
    { text: "/steer change course", preference: "queue" as const },
    { text: "change course", preference: "steer" as const },
  ])("steers $text into the running turn at once under the $preference preference", async ({ text, preference }) => {
    const test = await mount({ runningSubmission: preference });
    try {
      await act(async () => saveComposerQueue(test.sessionId, []));
      const input = await submit(test, text);
      expect(test.send).toHaveBeenCalledExactlyOnceWith({ text: "/steer change course", images: [], files: [] });
      expect(composerQueue(test.sessionId)).toEqual([]);
      expect(input.value).toBe("");
    } finally { await test.close(); }
  });

  it("queues a plain Enter behind work already held even under the steer preference", async () => {
    const test = await mount({ runningSubmission: "steer" });
    try {
      await submit(test, "after those");
      expect(test.send).not.toHaveBeenCalled();
      expect(composerQueue(test.sessionId).at(-1)).toEqual(expect.objectContaining({ text: "after those", mode: "followUp" }));
    } finally { await test.close(); }
  });

  it("holds /queue above the input until Send now steers it", async () => {
    const test = await mount({ runningSubmission: "steer" });
    try {
      await act(async () => saveComposerQueue(test.sessionId, []));
      const input = await submit(test, "/queue wait for me");
      expect(test.send).not.toHaveBeenCalled();
      expect(composerQueue(test.sessionId)).toEqual([
        expect.objectContaining({ text: "wait for me", mode: "followUp" }),
      ]);
      expect(test.node.querySelector(".composer-queue-text")?.textContent).toBe("wait for me");
      const queue = test.node.querySelector(".composer-queue")!;
      expect(queue.closest("form")).toBeNull();
      expect(queue.nextElementSibling).toBe(test.node.querySelector("form.composer"));
      expect(input.value).toBe("");
      await act(async () => (test.node.querySelector(".composer-queue-send") as HTMLButtonElement).click());
      expect(test.send).toHaveBeenCalledExactlyOnceWith({ text: "/steer wait for me", images: [], files: [] });
    } finally { await test.close(); }
  });

  it("submits for an unmounted composer the way its Enter would", async () => {
    const sessionId = crypto.randomUUID();
    const send = vi.fn(async () => undefined);
    submitComposerInput(sessionId, { text: "look here", images: [], files: [] }, { running: true, runningSubmission: "steer", send });
    expect(send).toHaveBeenCalledExactlyOnceWith({ text: "/steer look here", images: [], files: [] });
    submitComposerInput(sessionId, { text: "later", images: [], files: [] }, { running: true, runningSubmission: "queue", send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(composerQueue(sessionId)).toEqual([expect.objectContaining({ text: "later", mode: "followUp" })]);
    saveComposerQueue(sessionId, []);
  });

  it("sends /btw right away instead of holding it behind the turn or the queue", async () => {
    const test = await mount();
    try {
      const input = test.node.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "/btw what changed?");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(test.send).toHaveBeenCalledExactlyOnceWith({ text: "/btw what changed?", images: [], files: [] });
      expect(composerQueue(test.sessionId)).toHaveLength(2);
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
      expect(buttons.length).toBe(12);
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
