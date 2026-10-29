/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GoalSnapshot } from "../../shared/agent-contract";
import type { AgentSession, TranscriptItem } from "../backend/types";
import { GoalProgressRow, Inspector, shouldClearCommitMessage } from "./inspector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function session(): AgentSession {
  return {
    id: "session-1",
    title: "Session",
    subtitle: "",
    workspace: "/tmp/project",
    runtime: "gjc",
    status: "running",
    updatedAt: new Date().toISOString(),
    pinned: false,
    unread: false,
    accent: "#ffffff",
    ownership: "gajae",
    attachment: "attached",
  } as AgentSession;
}

function taskTool(id: string, status: string): TranscriptItem {
  return {
    id,
    sessionId: "session-1",
    kind: "tool",
    name: "task",
    description: "task",
    status,
    createdAt: "now",
    subagents: [],
  } as unknown as TranscriptItem;
}

const noop = () => undefined;

function props(transcript: TranscriptItem[]) {
  return {
    session: session(),
    transcript,
    liveSubagents: [],
    resuming: false,
    onResume: noop,
    onClose: noop,
  } as unknown as Parameters<typeof Inspector>[0];
}

describe("Inspector", () => {
  it("is memoized so a streamed chunk cannot re-render the panel", () => {
    // The panel is a child of the shell, so any state the shell owns -- a streamed
    // chunk, a keystroke in the composer -- re-runs it. It shows a few rows but scans
    // the whole transcript to find them, and on a long session that scan was repeating
    // for updates that could not change it. React only skips that for a memo
    // component, so the wrapper is the fix and has to be asserted: exporting the bare
    // function would silently undo it.
    const marker = (Inspector as unknown as { $$typeof: symbol }).$$typeof;
    expect(String(marker)).toBe("Symbol(react.memo)");
  });

  it("still lists the subagents the transcript declares", () => {
    // Guards the wrapper against being satisfied by something that renders nothing.
    const markup = renderToStaticMarkup(
      createElement(Inspector, props([taskTool("call-1", "running")])),
    );
    expect(markup).toContain("subagent-card");
    expect(markup).not.toContain("실행된 서브 에이전트가 없습니다");
  });

  it("says so when no subagent ran", () => {
    const markup = renderToStaticMarkup(createElement(Inspector, props([])));
    expect(markup).toContain("실행된 서브 에이전트가 없습니다");
  });

  it("offers native expandable details and keeps shell results after completion", () => {
    const tool = { ...taskTool("shell-1", "completed"), name: "bash", output: "finished output" } as TranscriptItem;
    const markup = renderToStaticMarkup(createElement(Inspector, props([tool])));
    expect(markup).toContain("<details");
    expect(markup).toContain("finished output");
    expect(markup).toContain("완료");
  });

  it("does not mark a queued task complete", () => {
    const markup = renderToStaticMarkup(createElement(Inspector, props([taskTool("queued", "pending")])));
    expect(markup).toContain("subagent-card--waiting");
  });

  it("clears a commit message only after success and only if it was not edited", () => {
    const submittedRevision = 3;

    // A rejected backend mutation is reported by mutate as unsuccessful, so its
    // typed message stays available alongside the error.
    expect(shouldClearCommitMessage(false, submittedRevision, submittedRevision)).toBe(
      false,
    );

    expect(shouldClearCommitMessage(true, submittedRevision, submittedRevision)).toBe(
      true,
    );
    expect(shouldClearCommitMessage(true, submittedRevision, submittedRevision + 1)).toBe(
      false,
    );
  });
});

describe("GoalProgressRow", () => {
  const ultragoalGoal = (overrides: Partial<GoalSnapshot> = {}): GoalSnapshot => ({
    enabled: true,
    mode: "active",
    objective: "Ship workflow cards",
    completed: 1,
    total: 2,
    progress: {
      ultragoal: {
        objective: "Ship workflow cards",
        counts: { total: 3, complete: 1, active: 1, pending: 0, blocked: 0, superseded: 1 },
        stories: [
          { id: "S1", title: "Parse the snapshot", status: "complete", verificationReceipt: true },
          { id: "S2", title: "Render the cards", status: "active", verificationReceipt: false },
          { id: "S3", title: "Old plan", status: "parked", verificationReceipt: false },
        ],
        omittedStories: 2,
        current: { id: "S2", title: "Render the cards" },
      },
      workflows: [],
      omittedWorkflows: 0,
    },
    ...overrides,
  });

  async function mount(goal: GoalSnapshot, onOperate = vi.fn()) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(GoalProgressRow, { goal, busy: false, onOperate }));
    });
    return {
      host,
      onOperate,
      cleanup: () => {
        act(() => root.unmount());
        host.remove();
      },
    };
  }

  it("shows the ultragoal counts and current story, and expands the story ledger", async () => {
    const { host, cleanup } = await mount(ultragoalGoal());
    try {
      expect(host.querySelector(".goal-progress-copy strong")?.textContent).toBe("Ship workflow cards");
      expect(host.querySelector(".goal-progress-stories")?.textContent).toBe("스토리 1/3");
      expect(host.querySelector(".goal-progress-current")?.textContent).toBe("Render the cards");
      expect(host.querySelector(".goal-story-list")).toBeNull();
      const toggle = [...host.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-expanded") !== null,
      )!;
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      await act(async () => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      const rows = [...host.querySelectorAll(".goal-story-list li")];
      expect(rows.map((row) => row.querySelector(".goal-story-status")?.textContent)).toEqual([
        "완료",
        "진행 중",
        "parked",
        undefined,
      ]);
      expect(rows[0]!.querySelector(".goal-story-receipt")?.textContent).toBe("검증 기록");
      expect(rows[1]!.querySelector(".goal-story-receipt")).toBeNull();
      expect(rows[3]!.textContent).toBe("스토리 2개 더 있음");
      expect(toggle.getAttribute("aria-controls")).toBe(
        host.querySelector(".goal-story-list")?.id,
      );
    } finally {
      cleanup();
    }
  });

  it("keeps pause and resume beside the story toggle", async () => {
    const active = await mount(ultragoalGoal());
    try {
      const pause = [...active.host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "일시정지",
      )!;
      await act(async () => pause.click());
      expect(active.onOperate).toHaveBeenCalledWith("pause");
    } finally {
      active.cleanup();
    }
    const paused = await mount(ultragoalGoal({ mode: "paused" }));
    try {
      const resume = [...paused.host.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "재개",
      )!;
      await act(async () => resume.click());
      expect(paused.onOperate).toHaveBeenCalledWith("resume");
    } finally {
      paused.cleanup();
    }
  });

  it("renders the plain goal row when no progress snapshot is available", async () => {
    const { host, cleanup } = await mount(ultragoalGoal({ progress: undefined }));
    try {
      expect(host.querySelector(".goal-progress-copy small")?.textContent).toBe("1/2");
      expect(host.querySelector(".goal-progress-stories")).toBeNull();
      expect(host.querySelector("[aria-expanded]")).toBeNull();
    } finally {
      cleanup();
    }
  });
});
