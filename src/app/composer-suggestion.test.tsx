/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, saveComposerQueue, type ComposerProps } from "./composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let focused = true;
let visibility = "visible";

beforeEach(() => {
  focused = true;
  visibility = "visible";
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Deferred {
  promise: Promise<string | null>;
  resolve: (value: string | null) => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: Deferred["resolve"];
  let reject!: Deferred["reject"];
  const promise = new Promise<string | null>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function baseProps(sessionId: string, overrides: Partial<ComposerProps>): ComposerProps {
  return {
    sessionId,
    running: false,
    sessionTitle: "Test",
    workspace: "/repo",
    workspaces: ["/repo"],
    commands: [{ name: "review", description: "Review a target", hint: "<target>" }],
    configOptions: [],
    runningSubmission: "queue",
    onSend: vi.fn(async () => undefined),
    onCancel: vi.fn(async () => undefined),
    onFlushQueued: vi.fn(async () => undefined),
    onCompact: () => {},
    onNewSession: () => {},
    onWorkspaceChange: () => {},
    onConfigChange: () => {},
    onCycleThinking: () => {},
    ...overrides,
  };
}

async function mount(overrides: Partial<ComposerProps> = {}) {
  const sessionId = crypto.randomUUID();
  saveComposerQueue(sessionId, []);
  const request = vi.fn<(sessionId: string) => Promise<string | null>>(async () => "테스트도 돌려줘");
  const props = baseProps(sessionId, { onSuggestNextInput: request, ...overrides });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  let current = props;
  const render = async (next: Partial<ComposerProps>) => {
    current = { ...current, ...next };
    await act(async () => root.render(createElement(Composer, current)));
  };
  await render({});
  const textarea = node.querySelector("textarea")!;
  return {
    sessionId,
    node,
    textarea,
    request,
    send: props.onSend as ReturnType<typeof vi.fn>,
    render,
    /** The shell announces a turn that ended normally by handing down a new object. */
    complete: (target: string = sessionId) => render({ turnCompletion: { sessionId: target } }),
    ghost: () => node.querySelector(".composer-ghost")?.textContent ?? null,
    close: async () => {
      await act(async () => root.unmount());
      node.remove();
      saveComposerQueue(sessionId, []);
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
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
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    textarea.dispatchEvent(event);
  });
  return event;
}

async function dispatch(textarea: HTMLTextAreaElement, type: string): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(new Event(type, { bubbles: true }));
  });
}

describe("composer next-input suggestion", () => {
  it("shows the prediction as ghost text when a turn completes, without touching the draft", async () => {
    const test = await mount();
    try {
      await test.complete();
      await settle();
      expect(test.request).toHaveBeenCalledWith(test.sessionId);
      expect(test.ghost()).toBe("테스트도 돌려줘");
      expect(test.textarea.value).toBe("");
      const hint = test.node.querySelector(".composer-ghost-hint")!;
      expect(hint.textContent).toBe("Tab으로 받기 · Esc로 닫기");
      expect(test.textarea.getAttribute("aria-describedby")).toBe(hint.id);
      // Drawn in the placeholder's place, so the two never overlap.
      expect(test.textarea.placeholder).toBe("");
    } finally {
      await test.close();
    }
  });

  it("accepts into the draft with Tab and never sends", async () => {
    const test = await mount();
    try {
      await test.complete();
      await settle();
      const tab = await press(test.textarea, "Tab");
      expect(tab.defaultPrevented).toBe(true);
      expect(test.textarea.value).toBe("테스트도 돌려줘");
      expect(test.ghost()).toBeNull();
      expect(test.send).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("dismisses with Esc, and Tab afterwards is an ordinary Tab", async () => {
    const test = await mount();
    try {
      await test.complete();
      await settle();
      await press(test.textarea, "Escape");
      expect(test.ghost()).toBeNull();
      expect(test.textarea.value).toBe("");
      expect(test.textarea.placeholder).toBe("무엇이든 요청하세요");
      expect((await press(test.textarea, "Tab")).defaultPrevented).toBe(false);
      expect(test.textarea.value).toBe("");
    } finally {
      await test.close();
    }
  });

  it("leaves Tab alone when there is no suggestion", async () => {
    const test = await mount();
    try {
      expect((await press(test.textarea, "Tab")).defaultPrevented).toBe(false);
      expect(test.textarea.value).toBe("");
    } finally {
      await test.close();
    }
  });

  it("leaves Shift+Tab, Ctrl+Tab and Alt+Tab to their own handlers", async () => {
    const cycle = vi.fn();
    const test = await mount({ onCycleThinking: cycle });
    try {
      await test.complete();
      await settle();
      for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }])
        expect((await press(test.textarea, "Tab", init)).defaultPrevented).toBe(false);
      await press(test.textarea, "Tab", { shiftKey: true });
      expect(cycle).toHaveBeenCalledTimes(1);
      expect(test.ghost()).toBe("테스트도 돌려줘");
      expect(test.textarea.value).toBe("");
    } finally {
      await test.close();
    }
  });

  it("hides the suggestion when the user types, and does not bring it back when the draft is cleared", async () => {
    const test = await mount();
    try {
      await test.complete();
      await settle();
      await type(test.textarea, "a");
      expect(test.ghost()).toBeNull();
      await type(test.textarea, "");
      expect(test.ghost()).toBeNull();
      expect((await press(test.textarea, "Tab")).defaultPrevented).toBe(false);
    } finally {
      await test.close();
    }
  });

  it("does not accept while the IME is composing, and starting a composition drops it", async () => {
    const test = await mount();
    try {
      await test.complete();
      await settle();
      expect((await press(test.textarea, "Tab", { isComposing: true })).defaultPrevented).toBe(false);
      expect(test.textarea.value).toBe("");
      await dispatch(test.textarea, "compositionstart");
      expect(test.ghost()).toBeNull();
      await dispatch(test.textarea, "compositionend");
      expect((await press(test.textarea, "Tab")).defaultPrevented).toBe(false);
      expect(test.textarea.value).toBe("");
    } finally {
      await test.close();
    }
  });

  it("drops the suggestion when the slash popup opens", async () => {
    const test = await mount();
    try {
      await test.complete();
      await settle();
      await type(test.textarea, "/rev");
      expect(test.ghost()).toBeNull();
      await press(test.textarea, "Tab");
      expect(test.textarea.value).toBe("/review ");
    } finally {
      await test.close();
    }
  });

  it("drops the suggestion when a new turn starts", async () => {
    const test = await mount();
    try {
      await test.complete();
      await settle();
      await test.render({ running: true });
      expect(test.ghost()).toBeNull();
      await test.render({ running: false });
      expect(test.ghost()).toBeNull();
    } finally {
      await test.close();
    }
  });

  it("discards an answer that arrives after the user started typing", async () => {
    const pending = deferred();
    const test = await mount({ onSuggestNextInput: vi.fn(() => pending.promise) });
    try {
      await test.complete();
      await type(test.textarea, "x");
      await type(test.textarea, "");
      await act(async () => pending.resolve("늦게 도착"));
      expect(test.ghost()).toBeNull();
    } finally {
      await test.close();
    }
  });

  it("discards an answer that arrives after a session switch", async () => {
    const pending = deferred();
    const test = await mount({ onSuggestNextInput: vi.fn(() => pending.promise) });
    try {
      await test.complete();
      const other = crypto.randomUUID();
      saveComposerQueue(other, []);
      await test.render({ sessionId: other });
      await act(async () => pending.resolve("다른 세션 제안"));
      expect(test.ghost()).toBeNull();
      await test.render({ sessionId: test.sessionId });
      expect(test.ghost()).toBeNull();
      saveComposerQueue(other, []);
    } finally {
      await test.close();
    }
  });

  it("lets a newer request win over an older answer", async () => {
    const first = deferred();
    const second = deferred();
    const request = vi.fn<(id: string) => Promise<string | null>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const test = await mount({ onSuggestNextInput: request });
    try {
      await test.complete();
      await test.complete();
      expect(request).toHaveBeenCalledTimes(2);
      await act(async () => first.resolve("오래된 제안"));
      expect(test.ghost()).toBeNull();
      await act(async () => second.resolve("새 제안"));
      expect(test.ghost()).toBe("새 제안");
    } finally {
      await test.close();
    }
  });

  it("gives up on a request after 30 seconds and discards its late answer", async () => {
    const pending = deferred();
    const test = await mount({ onSuggestNextInput: vi.fn(() => pending.promise) });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await test.complete();
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      await act(async () => pending.resolve("너무 늦음"));
      expect(test.ghost()).toBeNull();
    } finally {
      vi.useRealTimers();
      await test.close();
    }
  });

  it("shows nothing for a null suggestion or a failed request", async () => {
    const test = await mount({ onSuggestNextInput: vi.fn(async () => null) });
    try {
      await test.complete();
      await settle();
      expect(test.ghost()).toBeNull();
      await test.render({ onSuggestNextInput: vi.fn(async () => Promise.reject(new Error("busy"))) });
      await test.complete();
      await settle();
      expect(test.ghost()).toBeNull();
      expect(test.node.querySelector(".composer-error")).toBeNull();
    } finally {
      await test.close();
    }
  });
});

describe("when a suggestion is requested", () => {
  it("asks nothing when the window is unfocused", async () => {
    const test = await mount();
    try {
      focused = false;
      await test.complete();
      await settle();
      expect(test.request).not.toHaveBeenCalled();
      expect(test.ghost()).toBeNull();
    } finally {
      await test.close();
    }
  });

  it("asks nothing when the window is hidden", async () => {
    const test = await mount();
    try {
      visibility = "hidden";
      await test.complete();
      await settle();
      expect(test.request).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("asks nothing for a turn that finished in another session", async () => {
    const test = await mount();
    try {
      await test.complete("another-session");
      await settle();
      expect(test.request).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("does not treat a completion already on the shell at mount, or a session switch, as a new turn end", async () => {
    const sessionId = crypto.randomUUID();
    const test = await mount({ sessionId, turnCompletion: { sessionId } });
    try {
      await settle();
      expect(test.request).not.toHaveBeenCalled();
      const other = crypto.randomUUID();
      saveComposerQueue(other, []);
      await test.render({ sessionId: other });
      await test.render({ sessionId });
      expect(test.request).not.toHaveBeenCalled();
      saveComposerQueue(other, []);
    } finally {
      await test.close();
    }
  });

  it("asks nothing when the composer is not empty, is queueing, or still running", async () => {
    const test = await mount();
    try {
      await type(test.textarea, "draft");
      await test.complete();
      expect(test.request).not.toHaveBeenCalled();
      await type(test.textarea, "");
      await test.render({ running: true });
      await test.complete();
      expect(test.request).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("asks nothing on a view-only device or a backend that cannot suggest", async () => {
    const viewOnly = await mount({ readOnly: true });
    try {
      await viewOnly.complete();
      await settle();
      expect(viewOnly.request).not.toHaveBeenCalled();
    } finally {
      await viewOnly.close();
    }
    const unsupported = await mount({ onSuggestNextInput: undefined });
    try {
      await unsupported.complete();
      await settle();
      expect(unsupported.ghost()).toBeNull();
    } finally {
      await unsupported.close();
    }
  });
});
