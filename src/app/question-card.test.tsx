/**
 * @vitest-environment happy-dom
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionActivity, QuestionSubmission } from "../backend/types";
import { QuestionBanner, QuestionCard } from "./question-card";

function question(overrides: Partial<QuestionActivity> = {}): QuestionActivity {
  return {
    id: "g1",
    kind: "question",
    sessionId: "s1",
    question: "Ship it?",
    options: [
      { label: "Yes", recommended: true },
      { label: "No" },
    ],
    multi: false,
    status: "pending",
    createdAt: "now",
    answerable: true,
    tag: "pending",
    expectedSessionId: "s1",
    ...overrides,
  };
}

describe("question card", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  async function render(node: ReactNode): Promise<HTMLElement> {
    act(() => root?.unmount());
    host?.remove();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(node);
    });
    return host;
  }

  function card(item: QuestionActivity, onAnswer = vi.fn()) {
    return createElement(QuestionCard, { item, onAnswer });
  }

  async function typeOther(value: string): Promise<void> {
    const input = host?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error("other field missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function key(keyName: string, target?: EventTarget): Promise<void> {
    await act(async () => {
      (target ?? host?.querySelector("article"))?.dispatchEvent(
        new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true }),
      );
    });
  }

  it("submits a single choice immediately and shows the recommended hint", async () => {
    const onAnswer = vi.fn();
    const view = await render(card(question(), onAnswer));
    expect(view.querySelector('[role="radiogroup"]')).toBeTruthy();
    expect(view.querySelector(".is-recommended small")?.textContent).toBe("권장");
    expect(view.querySelector("[aria-live]")?.textContent).toContain("새 질문");
    const yes = view.querySelector("button");
    if (!(yes instanceof HTMLButtonElement)) throw new Error("option missing");
    await act(async () => {
      yes.click();
    });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    const [gateId, submission, idempotencyKey] = onAnswer.mock.calls[0] as [
      string,
      QuestionSubmission,
      string,
    ];
    expect(gateId).toBe("g1");
    expect(submission).toEqual({ selected: ["Yes"] });
    expect(idempotencyKey).toMatch(/^gajae-gate-g1-/u);
  });

  it("toggles a multi-select and submits the chosen labels", async () => {
    const onAnswer = vi.fn();
    const view = await render(
      card(question({ multi: true, options: [{ label: "Yes" }, { label: "No" }] }), onAnswer),
    );
    expect(view.querySelector('[role="group"]')).toBeTruthy();
    await act(async () => {
      (view.querySelectorAll(".question-option")[0] as HTMLButtonElement).click();
    });
    await act(async () => {
      (view.querySelectorAll(".question-option")[1] as HTMLButtonElement).click();
    });
    expect(onAnswer).not.toHaveBeenCalled();
    const buttons = [...view.querySelectorAll(".question-option")];
    expect(buttons[0]?.getAttribute("aria-checked")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-checked")).toBe("true");
    const done = [...view.querySelectorAll("button")].find((button) => button.textContent === "선택 완료");
    await act(async () => {
      (done as HTMLButtonElement).click();
    });
    expect(onAnswer.mock.calls[0]?.[1]).toEqual({ selected: ["Yes", "No"] });
  });

  it("sends free text as other and clears a selection", async () => {
    const onAnswer = vi.fn();
    const view = await render(card(question(), onAnswer));
    await key("1");
    await typeOther("something else");
    expect(view.querySelector(".question-option")?.getAttribute("aria-checked")).toBe("false");
    const send = [...view.querySelectorAll("button")].find((button) => button.textContent === "보내기");
    await act(async () => {
      (send as HTMLButtonElement).click();
    });
    expect(onAnswer.mock.calls[0]?.[1]).toEqual({
      selected: [],
      custom: "something else",
    });
  });

  it("selects with number keys, submits with Enter, and clears other with Escape", async () => {
    const onAnswer = vi.fn();
    await render(card(question(), onAnswer));
    await key("9");
    expect(onAnswer).not.toHaveBeenCalled();
    await key("2");
    await key("Enter");
    expect(onAnswer.mock.calls[0]?.[1]).toEqual({ selected: ["No"] });

    const typed = vi.fn();
    const typedView = await render(card(question(), typed));
    const input = typedView.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error("other field missing");
    await typeOther("draft");
    await key("1", input);
    await key("Enter");
    expect(typed).toHaveBeenCalledTimes(1);
    expect(typed.mock.calls[0]?.[1]).toEqual({
      selected: [],
      custom: "draft",
    });

    const cleared = vi.fn();
    const clearedView = await render(card(question(), cleared));
    const other = clearedView.querySelector("input");
    if (!(other instanceof HTMLInputElement)) throw new Error("other field missing");
    await typeOther("nope");
    await key("Escape", other);
    expect(other.value).toBe("");
    expect(document.activeElement).toBe(clearedView.querySelector(".question-option"));
    await key("Enter");
    expect(cleared).not.toHaveBeenCalled();
  });

  it("renders pending, answered, cancelled, timeout, and rejected states", async () => {
    const cases: Array<[Partial<QuestionActivity>, string]> = [
      [{ status: "answered", answerable: false, answerSummary: "Yes" }, "Yes"],
      [{ status: "cancelled", answerable: false }, "취소됨"],
      [{ status: "timeout", answerable: false }, "시간 초과"],
      [{ status: "rejected", answerable: true, error: "too many" }, "too many"],
    ];
    for (const [overrides, text] of cases) {
      const view = await render(card(question(overrides)));
      const article = view.querySelector("article");
      expect(article?.getAttribute("data-question-status")).toBe(overrides.status);
      expect(article?.textContent).toContain("Ship it?");
      expect(article?.textContent).toContain(text);
      if (overrides.status === "rejected")
        expect(view.querySelector('[role="alert"]')?.textContent).toBe("too many");
    }
  });

  it("focuses the pinned question", async () => {
    const view = await render(
      createElement(QuestionBanner, {
        pending: [question()],
        onAnswer: vi.fn(),
      }),
    );
    expect(document.activeElement).toBe(view.querySelector(".question-option"));
    await render(createElement(QuestionBanner, { pending: [], onAnswer: vi.fn() }));
    expect(host?.querySelector(".question-banner")).toBeNull();
  });
});
