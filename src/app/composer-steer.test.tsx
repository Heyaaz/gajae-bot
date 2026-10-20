/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Composer, composerQueue, saveComposerQueue, type ComposerProps } from "./composer";

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
