/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SideQuestionPanel } from "./side-question-panel";
import {
  sideQuestionText,
  sideQuestionWithContext,
  useSideQuestions,
  type SideExchange,
} from "./side-questions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const input = (text: string) => ({ text, images: [], files: [] });

describe("sideQuestionText", () => {
  it("takes the question from a bare /btw submission only", () => {
    expect(sideQuestionText(input("/btw  what changed?  "))).toBe("what changed?");
    expect(sideQuestionText(input("/BTW why\nthis"))).toBe("why\nthis");
    expect(sideQuestionText(input("/btw"))).toBeUndefined();
    expect(sideQuestionText(input("/btwx hi"))).toBeUndefined();
    expect(sideQuestionText(input("tell me /btw hi"))).toBeUndefined();
    expect(sideQuestionText({ ...input("/btw hi"), images: [{ name: "a.png" }] } as never)).toBeUndefined();
  });
});

describe("sideQuestionWithContext", () => {
  const answered = (question: string, answer: string): SideExchange => ({
    id: question, question, status: "answered", answer,
  });

  it("sends a first question as it is", () => {
    expect(sideQuestionWithContext([], "why?")).toBe("why?");
  });

  it("carries earlier answers into a follow-up, skipping unanswered ones", () => {
    const text = sideQuestionWithContext(
      [answered("which file?", "src/app.ts"), { id: "f", question: "lost", status: "failed", error: "x" }],
      "and the test?",
    );
    expect(text).toContain("Q: which file?\nA: src/app.ts");
    expect(text).not.toContain("lost");
    expect(text.endsWith("Follow-up question: and the test?")).toBe(true);
  });

  it("keeps only the newest answers that fit the budget", () => {
    const long = "가".repeat(3_000);
    const text = sideQuestionWithContext(
      [answered("first", long), answered("second", long), answered("third", "short")],
      "next",
    );
    expect(text).not.toContain("Q: first");
    expect(text).toContain("Q: second");
    expect(text).toContain("Q: third");
    expect(new TextEncoder().encode(text).length).toBeLessThan(16 * 1024);
  });
});

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function mount(node: Parameters<Root["render"]>[0]) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

describe("useSideQuestions", () => {
  function harness(ask: (sessionId: string, question: string) => Promise<string>) {
    const latest: { api?: ReturnType<typeof useSideQuestions> } = {};
    function Probe({ report }: { report: (api: ReturnType<typeof useSideQuestions>) => void }) {
      report(useSideQuestions(ask));
      return null;
    }
    mount(createElement(Probe, { report: (api) => (latest.api = api) }));
    return () => latest.api!;
  }

  it("answers, refuses a second question while one is pending, and retries a failure", async () => {
    let resolve!: (answer: string) => void;
    const ask = vi.fn(() => new Promise<string>((done) => (resolve = done)));
    const api = harness(ask);
    act(() => api().askSide("s1", "first"));
    act(() => api().askSide("s1", "second"));
    expect(api().threads.s1?.map((entry) => entry.status)).toEqual(["pending", "failed"]);
    expect(ask).toHaveBeenCalledTimes(1);

    await act(async () => resolve("answer one"));
    expect(api().threads.s1?.[0]).toMatchObject({ status: "answered", answer: "answer one" });

    const failed = api().threads.s1![1]!;
    act(() => api().retrySide("s1", failed.id));
    expect(api().threads.s1?.map((entry) => entry.question)).toEqual(["first", "second"]);
    expect(ask).toHaveBeenLastCalledWith("s1", expect.stringContaining("Follow-up question: second"));
  });

  it("drops an answer that arrives after the thread was cleared", async () => {
    let resolve!: (answer: string) => void;
    const api = harness(() => new Promise<string>((done) => (resolve = done)));
    act(() => api().askSide("s1", "first"));
    act(() => api().clearSide("s1"));
    await act(async () => resolve("late"));
    expect(api().threads.s1 ?? []).toEqual([]);
  });

  it("keeps each session's questions apart", async () => {
    const api = harness(async (sessionId) => `answer for ${sessionId}`);
    await act(async () => api().askSide("s1", "q"));
    await act(async () => api().askSide("s2", "q"));
    expect(api().threads.s1).toHaveLength(1);
    expect(api().threads.s2?.[0]).toMatchObject({ answer: "answer for s2" });
  });
});

describe("SideQuestionPanel", () => {
  const panel = (exchanges: SideExchange[], handlers: Partial<Record<"onAsk" | "onRetry" | "onClear" | "onClose", () => void>> = {}) =>
    mount(
      createElement(SideQuestionPanel, {
        exchanges,
        onAsk: handlers.onAsk ?? vi.fn(),
        onRetry: handlers.onRetry ?? vi.fn(),
        onClear: handlers.onClear ?? vi.fn(),
        onClose: handlers.onClose ?? vi.fn(),
      }),
    );

  function type(textarea: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("sends on Enter and closes on Escape", () => {
    const onAsk = vi.fn();
    const onClose = vi.fn();
    const host = panel([], { onAsk, onClose });
    expect(host.querySelector(".side-panel-empty")).not.toBeNull();
    const textarea = host.querySelector("textarea")!;
    type(textarea, "  what now?  ");
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onAsk).toHaveBeenCalledWith("what now?");
    expect(textarea.value).toBe("");
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("says the session's GJC cannot answer and takes no question", () => {
    const onAsk = vi.fn();
    const host = mount(
      createElement(SideQuestionPanel, {
        exchanges: [], unsupported: true, onAsk, onRetry: vi.fn(), onClear: vi.fn(), onClose: vi.fn(),
      }),
    );
    expect(host.querySelector('[role="status"]')?.textContent).toContain("지원하지 않습니다");
    expect(host.querySelector("textarea")!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".side-panel-send")!.disabled).toBe(true);
  });

  it("shows waiting, answers, and failures with a retry, and holds input while waiting", () => {
    const onRetry = vi.fn();
    const host = panel(
      [
        { id: "a", question: "q1", status: "answered", answer: "**done**" },
        { id: "b", question: "q2", status: "failed", error: "busy" },
        { id: "c", question: "q3", status: "pending" },
      ],
      { onRetry },
    );
    expect(host.querySelector(".side-exchange-answer strong")?.textContent).toBe("done");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("답을 기다리는 중…");
    act(() => host.querySelector<HTMLButtonElement>(".side-exchange-failed button")!.click());
    expect(onRetry).toHaveBeenCalledWith("b");
    type(host.querySelector("textarea")!, "more");
    expect(host.querySelector<HTMLButtonElement>(".side-panel-send")!.disabled).toBe(true);
  });
});
