/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionActivity } from "../backend/types";
import { QuestionCard } from "./question-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function question(overrides: Partial<QuestionActivity> = {}): QuestionActivity {
  return {
    id: "cli-ask:question-1",
    kind: "question",
    sessionId: "s1",
    question: "Choose a route",
    options: [{ label: "Exact A" }, { label: "Other…" }, { label: "Clarify" }],
    multi: false,
    status: "pending",
    createdAt: "now",
    answerable: true,
    tag: "pending",
    expectedSessionId: "s1",
    cli: { requestId: "interaction-1", interaction: "selector", selectedOptions: [], controls: [] },
    ...overrides,
  };
}

function cli(overrides: Partial<NonNullable<QuestionActivity["cli"]>> = {}): NonNullable<QuestionActivity["cli"]> {
  return { requestId: "interaction-1", interaction: "selector", selectedOptions: [], controls: [], ...overrides };
}

describe("ordinary CLI question card", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  async function render(item: QuestionActivity, onAnswer: ReturnType<typeof vi.fn>, props: { autoFocus?: boolean; answeredAbove?: boolean } = {}) {
    if (!host) {
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
    }
    await act(async () => root!.render(createElement(QuestionCard, { item, onAnswer, ...props })));
    return host;
  }

  async function click(button: HTMLButtonElement) {
    await act(async () => button.click());
  }

  async function type(input: HTMLTextAreaElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function key(target: Element, value: string, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
    await act(async () => { target.dispatchEvent(event); });
    return event;
  }

  it("renders only published options and immediately submits the exact single value", async () => {
    const answer = vi.fn();
    const view = await render(question(), answer, { autoFocus: true });
    expect(view.querySelector("article")?.getAttribute("data-question-id")).toBe("cli-ask:question-1");
    expect([...view.querySelectorAll(".question-option-label")].map((el) => el.textContent)).toEqual(["Exact A", "Other…", "Clarify"]);
    expect(view.querySelector("textarea")).toBeNull();
    const option = view.querySelector<HTMLButtonElement>(".question-option")!;
    expect(document.activeElement).toBe(option);
    await click(option);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0]?.slice(0, 2)).toEqual([
      "cli-ask:question-1",
      { selected: [], cli: { requestId: "interaction-1", answer: { kind: "value", value: "Exact A" } } },
    ]);
    expect(answer.mock.calls[0]?.[2]).toMatch(/^gajae-gate-/u);
  });

  it("submits multi toggles individually and displays authoritative selections and controls", async () => {
    const answer = vi.fn();
    const controls = [{ id: "next", label: "Done", enabled: true }, { id: "back", label: "Back", enabled: false }];
    const first = question({ multi: true, cli: cli({ selectedOptions: ["Exact A"], controls }) });
    const view = await render(first, answer);
    const options = view.querySelectorAll<HTMLButtonElement>(".question-option");
    expect(options[0]?.getAttribute("aria-checked")).toBe("true");
    expect(options[1]?.getAttribute("aria-checked")).toBe("false");
    const back = [...view.querySelectorAll("button")].find((button) => button.textContent === "Back")!;
    expect(back.disabled).toBe(true);
    await click(back);
    expect(answer).not.toHaveBeenCalled();
    await click(options[0]!);
    expect(answer.mock.calls[0]?.[1]).toEqual({ selected: [], cli: { requestId: "interaction-1", answer: { kind: "value", value: "Exact A" } } });
    expect(options[0]?.getAttribute("aria-checked")).toBe("true");
    await render({ ...first, cli: cli({ requestId: "interaction-2", selectedOptions: [], controls }) }, answer);
    expect(view.querySelector(".question-option")?.getAttribute("aria-checked")).toBe("false");
    await click([...view.querySelectorAll("button")].find((button) => button.textContent === "Done")!);
    expect(answer.mock.calls[1]?.[1]).toEqual({ selected: [], cli: { requestId: "interaction-2", answer: { kind: "control", controlId: "next" } } });
    expect(answer.mock.calls[1]?.[2]).not.toBe(answer.mock.calls[0]?.[2]);
  });

  it("waits for the published editor after Other and binds text to that interaction", async () => {
    const answer = vi.fn();
    const view = await render(question(), answer);
    await click(view.querySelectorAll<HTMLButtonElement>(".question-option")[1]!);
    expect(answer.mock.calls[0]?.[1]).toEqual({ selected: [], cli: { requestId: "interaction-1", answer: { kind: "value", value: "Other…" } } });
    expect(view.querySelector("textarea")).toBeNull();
    const editor = question({ cli: cli({ requestId: "editor-2", interaction: "custom_editor", editor: { title: "Tell us more", prefill: "Draft" }, controls: [{ id: "back", label: "Back", enabled: true }] }) });
    await render(editor, answer, { autoFocus: true });
    const input = view.querySelector("textarea")!;
    expect(input.value).toBe("Draft");
    expect(input.getAttribute("aria-label")).toBe("Tell us more");
    expect(view.textContent).toContain("Tell us more");
    expect(document.activeElement).toBe(input);
    await type(input, "  custom answer  ");
    await render({ ...editor }, answer, { autoFocus: true });
    expect(input.value).toBe("  custom answer  ");
    await key(input, "Enter");
    expect(answer.mock.calls[1]?.[1]).toEqual({ selected: [], cli: { requestId: "editor-2", answer: { kind: "value", value: "  custom answer  " } } });
  });

  it("preserves multiline prefill and sends multiline text after Shift+Enter", async () => {
    const answer = vi.fn();
    const item = question({ cli: cli({ interaction: "custom_editor", editor: { title: "Details", prefill: "first line\nsecond line" } }) });
    const view = await render(item, answer, { autoFocus: true });
    const editor = view.querySelector("textarea")!;
    expect(editor.value).toBe("first line\nsecond line");
    expect(document.activeElement).toBe(editor);
    expect((await key(editor, "Enter", { shiftKey: true })).defaultPrevented).toBe(false);
    expect(answer).not.toHaveBeenCalled();
    // Synthetic keydown has no native editing default in happy-dom.
    await type(editor, "first line\nsecond line\nthird line");
    expect((await key(editor, "Enter", { isComposing: true })).defaultPrevented).toBe(false);
    expect((await key(editor, "Escape", { isComposing: true })).defaultPrevented).toBe(false);
    expect((await key(editor, "Escape", { keyCode: 229 })).defaultPrevented).toBe(false);
    expect(editor.value).toBe("first line\nsecond line\nthird line");
    expect(answer).not.toHaveBeenCalled();
    expect((await key(editor, "Enter")).defaultPrevented).toBe(true);
    expect(answer.mock.calls[0]?.[1]).toEqual({ selected: [], cli: { requestId: "interaction-1", answer: { kind: "value", value: "first line\nsecond line\nthird line" } } });
  });

  it("uses the question as the accessible title when editor metadata is absent", async () => {
    const answer = vi.fn();
    const view = await render(question({ cli: cli({ interaction: "clarification_editor" }) }), answer);
    expect(view.querySelector("textarea")?.getAttribute("aria-label")).toBe("Choose a route");
  });

  it("guards synchronous double clicks and keeps the request ID seen by the user", async () => {
    const answer = vi.fn();
    const view = await render(question(), answer);
    const oldButton = view.querySelector<HTMLButtonElement>(".question-option")!;
    await act(async () => {
      oldButton.click();
      oldButton.click();
    });
    expect(answer).toHaveBeenCalledTimes(1);
    await render(question({ cli: cli({ requestId: "interaction-2" }) }), answer);
    await click(view.querySelector<HTMLButtonElement>(".question-option")!);
    expect(answer.mock.calls.map((call) => call[1].cli.requestId)).toEqual(["interaction-1", "interaction-2"]);
    expect(answer.mock.calls[0]?.[2]).not.toBe(answer.mock.calls[1]?.[2]);
  });

  it("activates the focused advertised control with Enter and consumes selector Escape", async () => {
    const answer = vi.fn();
    const item = question({
      options: [],
      cli: cli({ controls: [{ id: "disabled", label: "Unavailable", enabled: false }, { id: "next", label: "Next", enabled: true }] }),
    });
    const view = await render(item, answer, { autoFocus: true });
    const next = [...view.querySelectorAll("button")].find((button) => button.textContent === "Next")!;
    expect(document.activeElement).toBe(next);
    expect((await key(next, "Escape")).defaultPrevented).toBe(true);
    expect((await key(next, "Enter")).defaultPrevented).toBe(true);
    expect(answer.mock.calls[0]?.[1]).toEqual({ selected: [], cli: { requestId: "interaction-1", answer: { kind: "control", controlId: "next" } } });
  });

  it("unlocks on a changed error or status without losing editor text", async () => {
    const answer = vi.fn();
    const item = question({ cli: cli({ interaction: "clarification_editor", editor: { title: "Clarify" } }) });
    const view = await render(item, answer);
    const input = view.querySelector("textarea")!;
    await type(input, "Keep this");
    await key(input, "Enter");
    expect(input.disabled).toBe(true);
    await render({ ...item, status: "rejected", error: "invalid" }, answer);
    expect(input.value).toBe("Keep this");
    expect(input.disabled).toBe(false);
    expect(view.querySelector('[role="alert"]')?.textContent).toBe("invalid");
    await key(input, "Enter");
    expect(answer).toHaveBeenCalledTimes(2);
    await render({ ...item, status: "rejected", error: "invalid" }, answer);
    expect(input.disabled).toBe(true);
    await render({ ...item, status: "rejected", error: "invalid", cli: { ...item.cli!, rejectionRevision: 2 } }, answer);
    expect(input.disabled).toBe(false);
    await key(input, "Enter");
    expect(answer).toHaveBeenCalledTimes(3);
    await render({ ...item, cli: cli({ requestId: "new-editor", interaction: "clarification_editor", editor: { title: "Clarify", prefill: "New" } }) }, answer);
    expect(view.querySelector("textarea")?.value).toBe("New");
  });

  it("rejects blank editor values and owns Escape, Enter and number keys", async () => {
    const answer = vi.fn();
    const view = await render(question({ cli: cli({ interaction: "clarification_editor", editor: { title: "Clarify" } }) }), answer, { autoFocus: true });
    const input = view.querySelector("textarea")!;
    const escapeAtWindow = vi.fn();
    window.addEventListener("keydown", escapeAtWindow);
    try {
      await type(input, "   ");
      expect(view.querySelector<HTMLButtonElement>(".question-submit")?.disabled).toBe(true);
      expect((await key(input, "Enter")).defaultPrevented).toBe(true);
      expect(answer).not.toHaveBeenCalled();
      await type(input, "draft");
      expect((await key(input, "Escape")).defaultPrevented).toBe(true);
      expect(input.value).toBe("");
      expect(escapeAtWindow).not.toHaveBeenCalled();
      await render(question(), answer, { autoFocus: true });
      expect((await key(view.querySelector(".question-option")!, "2")).defaultPrevented).toBe(true);
      expect(answer).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(view.querySelectorAll(".question-option")[1]);
      await key(document.activeElement!, "Enter");
      expect(answer.mock.calls[0]?.[1].cli.answer).toEqual({ kind: "value", value: "Other…" });
    } finally {
      window.removeEventListener("keydown", escapeAtWindow);
    }
  });

  it("keeps settled and answered-above copies noninteractive", async () => {
    const answer = vi.fn();
    const view = await render(question(), answer, { answeredAbove: true });
    expect(view.querySelector("button")).toBeNull();
    expect(view.textContent).toContain("입력창 위에서 답해 주세요");
    expect(view.querySelector("article")?.getAttribute("data-question-id")).toBe("cli-ask:question-1");
    await render(question({ status: "answered", answerable: false, answerSummary: "Exact A" }), answer, { answeredAbove: true });
    expect(view.querySelector("button")).toBeNull();
    expect(view.textContent).toContain("Exact A");
    expect(view.textContent).not.toContain("입력창 위에서 답해 주세요");
    await render(question({ status: "closed", answerable: false }), answer, { answeredAbove: true });
    expect(view.querySelector("article")?.getAttribute("data-question-status")).toBe("closed");
    expect(view.textContent).toContain("질문이 종료됐어요");
    expect(view.textContent).not.toContain("답변을 기다리고 있어요");
    expect(view.textContent).not.toContain("취소됨");
    expect(view.querySelector("button, input, textarea")).toBeNull();
    expect(answer).not.toHaveBeenCalled();
  });
});
