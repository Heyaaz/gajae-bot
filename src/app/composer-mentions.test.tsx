/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileAttachment } from "../../shared/agent-contract";
import { Composer, saveComposerQueue, type ComposerProps } from "./composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_FILES = [
  "README.md",
  "src/app/renderer.ts",
  "scripts/attachment-render-smoke.mjs",
  "docs/레퍼런스.md",
];

function attachmentFor(relativePath: string): FileAttachment {
  return {
    id: `file-${relativePath}`,
    name: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    mimeType: "text/plain",
    size: 10,
    token: "t".repeat(43),
    label: relativePath,
  };
}

function installDesktopBridge() {
  const gjc = {
    listWorkspaceFiles: vi.fn(async () => ({
      files: WORKSPACE_FILES,
      truncated: false,
      source: "git" as const,
    })),
    attachWorkspaceFiles: vi.fn(async (_sessionId: string, paths: string[]) =>
      paths.map(attachmentFor),
    ),
  };
  (window as unknown as { agentControlDesktop?: unknown }).agentControlDesktop = {
    gjc,
    onCycleEffort: () => () => {},
  };
  return gjc;
}

afterEach(() => {
  delete (window as unknown as { agentControlDesktop?: unknown }).agentControlDesktop;
});

async function mount(overrides: Partial<ComposerProps> = {}) {
  const sessionId = crypto.randomUUID();
  saveComposerQueue(sessionId, []);
  const send = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(createElement(Composer, {
    sessionId,
    running: false,
    sessionTitle: "Test",
    workspace: "/repo",
    workspaces: ["/repo"],
    commands: [{ name: "review", description: "Review a target", hint: "<target>" }],
    configOptions: [],
    runningSubmission: "queue",
    onSend: send,
    onCancel: cancel,
    onFlushQueued: vi.fn(async () => undefined),
    onCompact: () => {},
    onNewSession: () => {},
    onWorkspaceChange: () => {},
    onConfigChange: () => {},
    onCycleThinking: () => {},
    ...overrides,
  })));
  const textarea = node.querySelector("textarea")!;
  return {
    sessionId,
    node,
    textarea,
    send,
    cancel,
    close: async () => {
      await act(async () => root.unmount());
      node.remove();
      saveComposerQueue(sessionId, []);
    },
  };
}

async function type(textarea: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      text,
    );
    textarea.setSelectionRange(text.length, text.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(
  textarea: HTMLTextAreaElement,
  key: string,
  init: KeyboardEventInit = {},
): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

async function dispatch(textarea: HTMLTextAreaElement, type: string): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(new Event(type, { bubbles: true }));
  });
}

async function nextFrame(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms + 20));
  });
}

function options(node: HTMLElement): string[] {
  return [...node.querySelectorAll(".mention-palette [role=option]")].map(
    (option) => option.getAttribute("title") ?? "",
  );
}

describe("composer @ mentions", () => {
  it("lists workspace files for @ren and attaches the one chosen with the arrows", async () => {
    const gjc = installDesktopBridge();
    const test = await mount();
    try {
      await type(test.textarea, "@ren");
      expect(gjc.listWorkspaceFiles).toHaveBeenCalledWith(test.sessionId);
      expect(options(test.node)).toEqual([
        "src/app/renderer.ts",
        "scripts/attachment-render-smoke.mjs",
      ]);

      await press(test.textarea, "ArrowDown");
      expect(
        test.node.querySelector(".mention-palette [aria-selected=true]")?.getAttribute("title"),
      ).toBe("scripts/attachment-render-smoke.mjs");
      await press(test.textarea, "Enter");

      expect(gjc.attachWorkspaceFiles).toHaveBeenCalledWith(test.sessionId, [
        "scripts/attachment-render-smoke.mjs",
      ]);
      expect(test.textarea.value).toBe("");
      expect(test.node.querySelector(".mention-palette")).toBeNull();
      expect(test.node.querySelector(".attachment-chip")?.textContent).toContain(
        "scripts/attachment-render-smoke.mjs",
      );
      expect(test.send).not.toHaveBeenCalled();

      await type(test.textarea, "이 스크립트를 봐줘");
      await press(test.textarea, "Enter");
      expect(test.send).toHaveBeenCalledWith({
        text: "이 스크립트를 봐줘",
        images: [],
        files: [attachmentFor("scripts/attachment-render-smoke.mjs")],
      });
    } finally {
      await test.close();
    }
  });

  it("chooses with Tab and keeps the rest of the sentence around the token", async () => {
    const gjc = installDesktopBridge();
    const test = await mount();
    try {
      await type(test.textarea, "look at @READ");
      await press(test.textarea, "Tab");
      expect(gjc.attachWorkspaceFiles).toHaveBeenCalledWith(test.sessionId, ["README.md"]);
      expect(test.textarea.value).toBe("look at ");
    } finally {
      await test.close();
    }
  });

  it("neither chooses nor sends while the Korean IME is composing", async () => {
    const gjc = installDesktopBridge();
    const test = await mount();
    try {
      await dispatch(test.textarea, "compositionstart");
      await type(test.textarea, "@레");
      expect(options(test.node)).toEqual(["docs/레퍼런스.md"]);

      await press(test.textarea, "Enter", { isComposing: true });
      await dispatch(test.textarea, "compositionend");
      // The same physical Enter arrives again right after the commit.
      await press(test.textarea, "Enter");
      await nextFrame();
      expect(gjc.attachWorkspaceFiles).not.toHaveBeenCalled();
      expect(test.send).not.toHaveBeenCalled();
      expect(test.textarea.value).toBe("@레");
      expect(options(test.node)).toEqual(["docs/레퍼런스.md"]);

      await nextFrame(100);
      await press(test.textarea, "Enter");
      expect(gjc.attachWorkspaceFiles).toHaveBeenCalledWith(test.sessionId, [
        "docs/레퍼런스.md",
      ]);
      expect(test.send).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("closes on Esc without stopping the running turn", async () => {
    installDesktopBridge();
    const test = await mount({ running: true });
    try {
      await type(test.textarea, "@ren");
      expect(test.node.querySelector(".mention-palette")).not.toBeNull();
      await press(test.textarea, "Escape");
      expect(test.node.querySelector(".mention-palette")).toBeNull();
      expect(test.cancel).not.toHaveBeenCalled();
      expect(test.textarea.value).toBe("@ren");
      await type(test.textarea, "@ren @");
      expect(test.node.querySelector(".mention-palette")).not.toBeNull();
    } finally {
      await test.close();
    }
  });

  it("leaves the slash palette in charge of a slash command", async () => {
    const gjc = installDesktopBridge();
    const test = await mount();
    try {
      await type(test.textarea, "/rev");
      expect(test.node.querySelector(".mention-palette")).toBeNull();
      await press(test.textarea, "Enter");
      expect(test.textarea.value).toBe("/review ");
      expect(gjc.listWorkspaceFiles).not.toHaveBeenCalled();

      await type(test.textarea, "/review @ren");
      expect(test.node.querySelector(".command-palette:not(.mention-palette)")).toBeNull();
      expect(options(test.node)[0]).toBe("src/app/renderer.ts");
    } finally {
      await test.close();
    }
  });

  it("treats @ as plain text without the desktop workspace bridge", async () => {
    const test = await mount();
    try {
      await type(test.textarea, "@ren");
      expect(test.node.querySelector(".mention-palette")).toBeNull();
      await press(test.textarea, "Enter");
      expect(test.send).toHaveBeenCalledWith({ text: "@ren", images: [], files: [] });
    } finally {
      await test.close();
    }
  });
});
