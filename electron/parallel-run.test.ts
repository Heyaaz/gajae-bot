import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionInput } from "./gjc-input-validation.js";
import { parallelStartInput } from "./parallel-ipc-handlers.js";
import {
  applyParallelEvent,
  parallelCleanupConfirmation,
  parseParallelGroup,
  ParallelTransitionError,
  type ParallelGroup,
  type ParallelGroupEvent,
} from "../shared/parallel-run.js";

function draft(attempts = 3): ParallelGroup {
  return {
    id: "group-1",
    title: "로그인 고치기",
    prompt: "로그인 버그를 고쳐 줘",
    workspace: "/repo",
    createdAt: 1,
    attempts: Array.from({ length: attempts }, (_, index) => ({
      id: String(index + 1),
      preset: index === 0 ? "codex-pro" : "codex-medium",
      branch: `gajae/best-of-abc-${index + 1}`,
      state: { kind: "creating" as const },
    })),
    state: { kind: "draft" },
  };
}

const run = (group: ParallelGroup, ...events: ParallelGroupEvent[]) =>
  events.reduce(applyParallelEvent, group);

const created = (attemptId: string): ParallelGroupEvent => ({
  type: "attempt.created",
  attemptId,
  sessionId: `s-${attemptId}`,
  worktreePath: `/wt/${attemptId}`,
});

describe("parallel group state machine", () => {
  it("stays a draft until every attempt has a session or a failure, then runs", () => {
    const partial = run(draft(), created("1"), {
      type: "attempt.failed",
      attemptId: "2",
      reason: "unknown profile",
    });
    expect(partial.state).toEqual({ kind: "draft" });

    const running = applyParallelEvent(partial, created("3"));
    expect(running.state).toEqual({ kind: "running" });
    expect(running.attempts.map((attempt) => attempt.state.kind)).toEqual([
      "started",
      "failed",
      "started",
    ]);
  });

  it("keeps a failed attempt's session when its request did not run", () => {
    const group = run(draft(2), created("1"), created("2"), {
      type: "attempt.failed",
      attemptId: "2",
      reason: "GJC rejected the prompt",
    });
    expect(group.attempts[1]!.state).toEqual({
      kind: "failed",
      reason: "GJC rejected the prompt",
      sessionId: "s-2",
      worktreePath: "/wt/2",
    });
    expect(group.state).toEqual({ kind: "running" });
  });

  it("moves running -> comparing -> adopted, and lets the pick change until cleanup removes something", () => {
    const comparing = run(draft(2), created("1"), created("2"), { type: "settled" });
    expect(comparing.state).toEqual({ kind: "comparing" });
    const adopted = applyParallelEvent(comparing, { type: "adopt", attemptId: "1" });
    expect(adopted.state).toEqual({ kind: "adopted", attemptId: "1" });
    const repicked = applyParallelEvent(adopted, { type: "adopt", attemptId: "2" });
    expect(repicked.state).toEqual({ kind: "adopted", attemptId: "2" });

    const cleaned = applyParallelEvent(repicked, { type: "attempt.removed", attemptId: "1" });
    expect(cleaned.attempts[0]!.state).toEqual({ kind: "removed" });
    expect(() => applyParallelEvent(cleaned, { type: "adopt", attemptId: "1" })).toThrow(
      ParallelTransitionError,
    );
  });

  it("never removes the adopted attempt", () => {
    const adopted = run(draft(2), created("1"), created("2"), {
      type: "adopt",
      attemptId: "2",
    });
    expect(() =>
      applyParallelEvent(adopted, { type: "attempt.removed", attemptId: "2" }),
    ).toThrow(ParallelTransitionError);
  });

  it("refuses decisions while attempts are still being created and removals before a decision", () => {
    const partial = applyParallelEvent(draft(2), created("1"));
    expect(() => applyParallelEvent(partial, { type: "adopt", attemptId: "1" })).toThrow(
      ParallelTransitionError,
    );
    expect(() => applyParallelEvent(partial, { type: "discard" })).toThrow(
      ParallelTransitionError,
    );
    const running = applyParallelEvent(partial, created("2"));
    expect(() =>
      applyParallelEvent(running, { type: "attempt.removed", attemptId: "1" }),
    ).toThrow(ParallelTransitionError);
  });

  it("cannot adopt an attempt that never got a session", () => {
    const group = run(draft(2), created("1"), {
      type: "attempt.failed",
      attemptId: "2",
      reason: "no worktree",
    });
    expect(() => applyParallelEvent(group, { type: "adopt", attemptId: "2" })).toThrow(
      ParallelTransitionError,
    );
  });

  it("fails the attempts an interrupted creation left behind, once", () => {
    const partial = applyParallelEvent(draft(3), created("1"));
    const interrupted = applyParallelEvent(partial, { type: "interrupted", reason: "restart" });
    expect(interrupted.state).toEqual({ kind: "running" });
    expect(interrupted.attempts.map((attempt) => attempt.state.kind)).toEqual([
      "started",
      "failed",
      "failed",
    ]);
    expect(applyParallelEvent(interrupted, { type: "interrupted", reason: "again" })).toBe(
      interrupted,
    );
  });
});

describe("parallel group records on disk", () => {
  it("round-trips a group and drops a record whose adoption names no attempt", () => {
    const group = run(draft(2), created("1"), created("2"), { type: "adopt", attemptId: "1" });
    expect(parseParallelGroup(JSON.parse(JSON.stringify(group)))).toEqual(group);
    expect(
      parseParallelGroup({ ...group, state: { kind: "adopted", attemptId: "9" } }),
    ).toBeUndefined();
    expect(parseParallelGroup({ ...group, attempts: group.attempts.slice(0, 1) })).toBeUndefined();
    expect(
      parseParallelGroup({
        ...group,
        attempts: [{ ...group.attempts[0], branch: "--force" }, group.attempts[1]],
      }),
    ).toBeUndefined();
  });
});

describe("the IPC boundary", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "gajae-parallel-input-"));
  const valid = {
    title: " 로그인 ",
    workspace,
    prompt: " 고쳐 줘 ",
    branch: "feat/login",
    presets: ["codex-pro", " codex-eco "],
  };

  it("accepts 2-4 presets with a request and trims what it keeps", () => {
    expect(parallelStartInput(valid)).toEqual({
      title: "로그인",
      workspace,
      prompt: "고쳐 줘",
      branch: "feat/login",
      presets: ["codex-pro", "codex-eco"],
    });
  });

  it.each([
    ["one attempt", { presets: ["codex-pro"] }],
    ["five attempts", { presets: Array(5).fill("codex-pro") }],
    ["no request", { prompt: "   " }],
    ["a branch git would read as an option", { branch: "-delete" }],
    ["a relative workspace", { workspace: "repo" }],
    ["a control character in a preset", { presets: ["codex-pro", "codex\u0000eco"] }],
  ])("refuses %s", (_label, override) => {
    expect(() => parallelStartInput({ ...valid, ...override })).toThrow();
  });

  it("lets a single create name its preset, and refuses one that is not a preset id", () => {
    const base = { runtime: "gjc", workspace, isolation: "worktree" };
    expect(createSessionInput({ ...base, modelPreset: "codex-eco" }).modelPreset).toBe("codex-eco");
    expect(createSessionInput(base)).not.toHaveProperty("modelPreset");
    expect(() => createSessionInput({ ...base, modelPreset: "" })).toThrow("model preset");
  });
});

describe("cleanup confirmation", () => {
  it("names every loss and the branch it keeps", () => {
    const { message, detail } = parallelCleanupConfirmation({
      groupId: "group-1",
      keptBranch: "gajae/best-of-abc-1",
      items: [
        {
          attemptId: "2",
          branch: "gajae/best-of-abc-2",
          worktreePath: "/wt/2",
          uncommittedFiles: 3,
          branchExists: true,
          unpushedCommits: 2,
          sessionId: "s-2",
        },
        {
          attemptId: "3",
          branch: "gajae/best-of-abc-3",
          worktreePath: "/wt/3",
          uncommittedFiles: 0,
          branchExists: true,
          unpushedCommits: 0,
        },
      ],
    });
    expect(message).toBe("채택하지 않은 시도를 정리할까요?");
    expect(detail).toContain("커밋하지 않은 변경 3개가 사라집니다");
    expect(detail).toContain("gajae/best-of-abc-2 (push하지 않은 커밋 2개가 사라집니다)");
    expect(detail).toContain("브랜치 삭제: gajae/best-of-abc-3\n");
    expect(detail).not.toContain("gajae/best-of-abc-3 (push");
    expect(detail).toContain("채택한 브랜치 gajae/best-of-abc-1");
  });
});
