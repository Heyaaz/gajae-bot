/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionProgress } from "../../shared/agent-contract";
import { WorkflowStatusCards } from "./workflow-status";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function progress(overrides: Partial<SessionProgress> = {}): SessionProgress {
  return {
    ultragoal: null,
    workflows: [
      {
        skill: "ralplan",
        phase: "critic-review",
        summary: "Planner pass 2 under review",
        chips: [
          { label: "pass", value: "2", severity: null },
          { label: "verdict", value: "ITERATE", severity: "warning" },
          { label: "pending", value: "approval", severity: "warning" },
        ],
        verdict: "ITERATE",
      },
      {
        skill: "autoresearch",
        phase: "evaluating",
        summary: null,
        chips: [
          { label: "metric", value: "p95 412ms", severity: "success" },
          { label: "blocked", value: null, severity: "blocked" },
        ],
        verdict: null,
      },
    ],
    omittedWorkflows: 0,
    ...overrides,
  };
}

describe("WorkflowStatusCards", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  async function render(
    value?: SessionProgress,
    extra: { onEnd?: (skill: string) => void; endingSkill?: string | null } = {},
  ): Promise<HTMLElement> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(WorkflowStatusCards, { progress: value, ...extra }));
    });
    return host;
  }

  it("shows one card per active workflow with phase, summary, severity chips and verdict", async () => {
    const view = await render(progress());
    const cards = [...view.querySelectorAll(".workflow-status-card")];
    expect(cards.map((card) => card.getAttribute("data-workflow"))).toEqual([
      "ralplan",
      "autoresearch",
    ]);
    const ralplan = cards[0]!;
    expect(ralplan.querySelector(".workflow-status-phase")?.textContent).toBe("critic-review");
    expect(ralplan.querySelector(".workflow-status-summary")?.textContent).toBe(
      "Planner pass 2 under review",
    );
    expect(ralplan.querySelector(".workflow-status-verdict")?.textContent).toBe("리뷰 ITERATE");
    expect([...ralplan.querySelectorAll(".workflow-chip")].map((chip) => [
      chip.className,
      chip.textContent,
    ])).toEqual([
      ["workflow-chip workflow-chip--plain", "pass2"],
      ["workflow-chip workflow-chip--warning", "pendingapproval"],
    ]);

    const autoresearch = cards[1]!;
    expect(autoresearch.querySelector(".workflow-status-summary")).toBeNull();
    expect(autoresearch.querySelector(".workflow-status-verdict")).toBeNull();
    expect([...autoresearch.querySelectorAll(".workflow-chip")].map((chip) => chip.className)).toEqual([
      "workflow-chip workflow-chip--success",
      "workflow-chip workflow-chip--blocked",
    ]);
    expect(view.querySelector(".workflow-status-more")).toBeNull();
  });

  it("says how many workflows the runtime left out", async () => {
    const view = await render(progress({ omittedWorkflows: 3 }));
    expect(view.querySelector(".workflow-status-more")?.textContent).toBe("워크플로 3개 더 있음");
  });

  it("offers to end a workflow GJC can end, and only that one", async () => {
    const ended: string[] = [];
    const view = await render(
      progress({
        workflows: [
          { skill: "deep-interview", phase: "interviewing", summary: null, chips: [], verdict: null },
          { skill: "mystery-flow", phase: "running", summary: null, chips: [], verdict: null },
        ],
      }),
      { onEnd: (skill) => ended.push(skill) },
    );
    const buttons = [...view.querySelectorAll<HTMLButtonElement>(".workflow-status-end")];
    expect(buttons.map((button) => button.closest(".workflow-status-card")?.getAttribute("data-workflow"))).toEqual([
      "deep-interview",
    ]);
    expect(buttons[0]!.textContent).toBe("워크플로 끝내기");
    expect(buttons[0]!.getAttribute("aria-label")).toBe("deep-interview 워크플로 끝내기");
    await act(async () => buttons[0]!.click());
    expect(ended).toEqual(["deep-interview"]);
  });

  it("shows no end button when nothing can act on it", async () => {
    expect((await render(progress())).querySelector(".workflow-status-end")).toBeNull();
  });

  it("locks the end buttons while one workflow is ending", async () => {
    const view = await render(progress(), { onEnd: () => undefined, endingSkill: "ralplan" });
    const buttons = [...view.querySelectorAll<HTMLButtonElement>(".workflow-status-end")];
    expect(buttons.map((button) => [button.textContent, button.disabled])).toEqual([
      ["끝내는 중…", true],
      ["워크플로 끝내기", true],
    ]);
  });

  it("renders nothing without a snapshot or without an active workflow", async () => {
    expect((await render(undefined)).innerHTML).toBe("");
    act(() => root?.unmount());
    host?.remove();
    expect((await render(progress({ workflows: [] }))).innerHTML).toBe("");
  });
});
