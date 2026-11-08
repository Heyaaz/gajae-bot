/**
 * @vitest-environment happy-dom
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionActivity, QuestionSubmission } from "../backend/types";
import { QuestionBanner, QuestionCard } from "./question-card";
import { questionParts } from "./question-parts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

  it("splits a deep-interview prompt into its round header, listing, and ask", async () => {
    const prompt = [
      "Round 0 | 토폴로지 확인 | Ambiguity: 아직 채점 전",
      "이렇게 3개의 최상위 컴포넌트로 이해했습니다:",
      "1. 계산기 코어 (calc.js)",
      "2. 추가 기능 (미정)",
      "확정 의도(Locked intent):",
      "- Artifacts: artifact:calc-module",
      "이 토폴로지와 확정 의도가 맞습니까?",
    ].join("\n");
    expect(questionParts(prompt)).toEqual({
      meta: ["Round 0", "토폴로지 확인", "Ambiguity: 아직 채점 전"],
      context: prompt.split("\n").slice(1, -1).join("\n"),
      ask: "이 토폴로지와 확정 의도가 맞습니까?",
    });
    const view = await render(card(question({ question: prompt })));
    expect([...view.querySelectorAll(".question-card-meta span")].map((el) => el.textContent))
      .toEqual(["Round 0", "토폴로지 확인", "Ambiguity: 아직 채점 전"]);
    expect(view.querySelector(".question-card-context")?.textContent).toContain("1. 계산기 코어 (calc.js)\n2.");
    expect(view.querySelector(".question-card-line")?.textContent).toBe("이 토폴로지와 확정 의도가 맞습니까?");
    const group = view.querySelector('[role="radiogroup"]');
    const label = view.querySelector(`[id="${group?.getAttribute("aria-labelledby") ?? ""}"]`);
    expect(label?.textContent).toContain("Ambiguity");
    expect(label?.textContent).toContain("맞습니까?");
  });

  it("keeps a one-line or list-ending prompt whole", () => {
    expect(questionParts("Ship it?")).toEqual({ meta: [], context: "", ask: "Ship it?" });
    expect(questionParts("Round 3 | Goal\nWhat first?")).toEqual({
      meta: ["Round 3", "Goal"],
      context: "",
      ask: "What first?",
    });
    expect(questionParts("Pick one:\n- A\n- B")).toEqual({
      meta: [],
      context: "Pick one:\n- A\n- B",
      ask: "",
    });
    expect(questionParts("Round 1 | only a header")).toEqual({
      meta: [],
      context: "",
      ask: "Round 1 | only a header",
    });
  });

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

  it("keeps the nonce when a question ID is long", async () => {
    const onAnswer = vi.fn();
    const item = question({ id: "g".repeat(300) });
    const first = await render(card(item, onAnswer));
    await act(async () => (first.querySelector("button") as HTMLButtonElement).click());
    const second = await render(card(item, onAnswer));
    await act(async () => (second.querySelector("button") as HTMLButtonElement).click());
    const keys = onAnswer.mock.calls.map((call) => call[2] as string);
    expect(keys[0]?.length).toBeLessThanOrEqual(200);
    expect(keys[1]?.length).toBeLessThanOrEqual(200);
    expect(keys[0]).not.toBe(keys[1]);
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

  it("labels a ralplan approval and answers it like a question", async () => {
    const onAnswer = vi.fn();
    const approval = question({
      approval: true,
      question: "Approve the final plan .gjc/plans/ralplan-final-2.md?",
      options: [
        { label: "Refine further" },
        { label: "Approve execution via ultragoal", recommended: true },
        { label: "Stop here" },
      ],
    });
    const view = await render(card(approval, onAnswer));
    expect(view.querySelector(".question-card--approval")).toBeTruthy();
    expect(view.querySelector(".question-card-kind")?.textContent).toBe("계획 승인");
    expect(view.querySelector("[aria-live]")?.textContent).toContain("계획 승인 요청");
    await act(async () => {
      (view.querySelectorAll(".question-option")[1] as HTMLButtonElement).click();
    });
    expect(onAnswer.mock.calls[0]?.slice(0, 2)).toEqual([
      "g1",
      { selected: ["Approve execution via ultragoal"] },
    ]);

    const settled = await render(
      card({ ...approval, status: "answered", answerable: false, answerSummary: "Stop here" }),
    );
    expect(settled.querySelector(".question-card-kind")?.textContent).toBe("계획 승인");
    expect(settled.textContent).toContain("Stop here");

    const plain = await render(card(question()));
    expect(plain.querySelector(".question-card-kind")).toBeNull();
  });

  it("leaves only a marker in the transcript while the pinned copy is open", async () => {
    const open = await render(
      createElement(QuestionCard, { item: question(), onAnswer: vi.fn(), answeredAbove: true }),
    );
    expect(open.querySelector(".question-option")).toBeNull();
    expect(open.querySelector("input")).toBeNull();
    expect(open.textContent).toContain("Ship it?");
    expect(open.textContent).toContain("입력창 위에서 답해 주세요");

    const answered = await render(
      createElement(QuestionCard, {
        item: question({ status: "answered", answerable: false, answerSummary: "Yes" }),
        onAnswer: vi.fn(),
        answeredAbove: true,
      }),
    );
    expect(answered.textContent).toContain("Yes");
    expect(answered.textContent).not.toContain("입력창 위에서 답해 주세요");
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
