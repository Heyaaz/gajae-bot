/**
 * Best-of-N: one request run as 2-4 attempts, each in its own managed worktree on
 * its own model preset, compared side by side and resolved by adopting one.
 *
 * The group is one durable record whose state only moves through
 * `applyParallelEvent`, so the rail, the comparison view and the cleanup all read
 * the same answer instead of reconstructing it from flags.
 */

export const PARALLEL_ATTEMPT_MIN = 2;
export const PARALLEL_ATTEMPT_MAX = 4;
export const PARALLEL_PROMPT_LIMIT = 100_000;

export type ParallelAttemptState =
  /** Its session has not been created yet. */
  | { kind: "creating" }
  /** The session exists and the request was handed to it once. */
  | { kind: "started"; sessionId: string; worktreePath: string }
  /** Creation failed, or the request did not run. A session that exists is kept. */
  | { kind: "failed"; reason: string; sessionId?: string; worktreePath?: string }
  /** Its worktree and branch were cleaned up after the group was resolved. */
  | { kind: "removed" };

export interface ParallelAttempt {
  id: string;
  preset: string;
  branch: string;
  state: ParallelAttemptState;
}

export type ParallelGroupState =
  /** Attempts are still being created. */
  | { kind: "draft" }
  | { kind: "running" }
  /** Every started attempt finished its turn. */
  | { kind: "comparing" }
  | { kind: "adopted"; attemptId: string }
  | { kind: "discarded" };

export interface ParallelGroup {
  id: string;
  title: string;
  prompt: string;
  /** The folder the user picked; every attempt's worktree comes from its repository. */
  workspace: string;
  createdAt: number;
  attempts: ParallelAttempt[];
  state: ParallelGroupState;
}

export type ParallelGroupEvent =
  | {
      type: "attempt.created";
      attemptId: string;
      sessionId: string;
      worktreePath: string;
    }
  | { type: "attempt.failed"; attemptId: string; reason: string }
  /** The process that was creating attempts is gone; nobody will finish them. */
  | { type: "interrupted"; reason: string }
  | { type: "settled" }
  | { type: "adopt"; attemptId: string }
  | { type: "discard" }
  | { type: "attempt.removed"; attemptId: string };

export class ParallelTransitionError extends Error {}

export function attemptSessionId(attempt: ParallelAttempt): string | undefined {
  return attempt.state.kind === "started" || attempt.state.kind === "failed"
    ? attempt.state.sessionId
    : undefined;
}

function decided(group: ParallelGroup): boolean {
  return group.state.kind === "adopted" || group.state.kind === "discarded";
}

/** Draft ends the moment no attempt is still being created. */
function afterCreation(group: ParallelGroup): ParallelGroup {
  return group.state.kind === "draft" &&
    group.attempts.every((attempt) => attempt.state.kind !== "creating")
    ? { ...group, state: { kind: "running" } }
    : group;
}

export function applyParallelEvent(
  group: ParallelGroup,
  event: ParallelGroupEvent,
): ParallelGroup {
  const reject = (reason: string): never => {
    throw new ParallelTransitionError(`${event.type}: ${reason}`);
  };
  const attemptOf = (attemptId: string): ParallelAttempt =>
    group.attempts.find((attempt) => attempt.id === attemptId) ??
    reject(`unknown attempt ${attemptId}`);
  const replace = (
    attemptId: string,
    state: ParallelAttemptState,
  ): ParallelGroup => ({
    ...group,
    attempts: group.attempts.map((attempt) =>
      attempt.id === attemptId ? { ...attempt, state } : attempt,
    ),
  });

  switch (event.type) {
    case "attempt.created": {
      const attempt = attemptOf(event.attemptId);
      if (group.state.kind !== "draft" || attempt.state.kind !== "creating")
        return reject("attempt is not being created");
      return afterCreation(
        replace(attempt.id, {
          kind: "started",
          sessionId: event.sessionId,
          worktreePath: event.worktreePath,
        }),
      );
    }
    case "attempt.failed": {
      const attempt = attemptOf(event.attemptId);
      if (decided(group)) return reject("group is already decided");
      if (attempt.state.kind === "creating")
        return afterCreation(
          replace(attempt.id, { kind: "failed", reason: event.reason }),
        );
      if (attempt.state.kind !== "started") return reject("attempt is not running");
      const { sessionId, worktreePath } = attempt.state;
      return replace(attempt.id, {
        kind: "failed",
        reason: event.reason,
        sessionId,
        worktreePath,
      });
    }
    case "interrupted":
      if (group.state.kind !== "draft") return group;
      return afterCreation({
        ...group,
        attempts: group.attempts.map((attempt) =>
          attempt.state.kind === "creating"
            ? { ...attempt, state: { kind: "failed", reason: event.reason } }
            : attempt,
        ),
      });
    case "settled":
      if (group.state.kind === "comparing") return group;
      if (group.state.kind !== "running") return reject("group is not running");
      return { ...group, state: { kind: "comparing" } };
    case "adopt": {
      const attempt = attemptOf(event.attemptId);
      // A different pick stays possible until cleanup has removed something: the
      // native confirmation names the kept branch, and cancelling it is how a
      // wrong pick is noticed.
      const repickable =
        group.state.kind === "adopted" &&
        group.attempts.every((entry) => entry.state.kind !== "removed");
      if (
        group.state.kind !== "running" &&
        group.state.kind !== "comparing" &&
        !repickable
      )
        return reject("group cannot adopt now");
      if (!attemptSessionId(attempt)) return reject("attempt has no session");
      return { ...group, state: { kind: "adopted", attemptId: attempt.id } };
    }
    case "discard":
      if (group.state.kind !== "running" && group.state.kind !== "comparing")
        return reject("group cannot be discarded now");
      return { ...group, state: { kind: "discarded" } };
    case "attempt.removed": {
      const attempt = attemptOf(event.attemptId);
      if (!decided(group)) return reject("group is not decided");
      if (group.state.kind === "adopted" && group.state.attemptId === attempt.id)
        return reject("the adopted attempt is kept");
      if (attempt.state.kind === "removed") return group;
      if (attempt.state.kind === "creating") return reject("attempt is being created");
      return replace(attempt.id, { kind: "removed" });
    }
  }
}

const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/u;

/** A branch name git accepts and that cannot reach a shell as an option. */
export function safeBranchName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    BRANCH_PATTERN.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith(".lock")
  );
}

export function safeModelPreset(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 128 &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

/** Every attempt gets a fresh branch: `-1`, `-2`, … after the base name. */
export function parallelAttemptBranch(base: string, attemptId: string): string {
  return `${base}-${attemptId}`;
}

function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function parseAttemptState(value: unknown): ParallelAttemptState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  const session = text(state.sessionId, 256) ? state.sessionId : undefined;
  const worktree = text(state.worktreePath, 4096) ? state.worktreePath : undefined;
  switch (state.kind) {
    case "creating":
      return { kind: "creating" };
    case "started":
      return session && worktree
        ? { kind: "started", sessionId: session, worktreePath: worktree }
        : undefined;
    case "failed":
      if (typeof state.reason !== "string") return undefined;
      return {
        kind: "failed",
        reason: state.reason.slice(0, 2000),
        ...(session ? { sessionId: session } : {}),
        ...(session && worktree ? { worktreePath: worktree } : {}),
      };
    case "removed":
      return { kind: "removed" };
    default:
      return undefined;
  }
}

function parseGroupState(value: unknown): ParallelGroupState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  switch (state.kind) {
    case "draft":
    case "running":
    case "comparing":
    case "discarded":
      return { kind: state.kind };
    case "adopted":
      return text(state.attemptId, 16)
        ? { kind: "adopted", attemptId: state.attemptId }
        : undefined;
    default:
      return undefined;
  }
}

/** A group read from disk, or undefined when the record is not one. */
export function parseParallelGroup(value: unknown): ParallelGroup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    !text(raw.id, 128) ||
    !text(raw.title, 256) ||
    !text(raw.prompt, PARALLEL_PROMPT_LIMIT) ||
    !text(raw.workspace, 4096) ||
    typeof raw.createdAt !== "number" ||
    !Number.isFinite(raw.createdAt) ||
    !Array.isArray(raw.attempts) ||
    raw.attempts.length < PARALLEL_ATTEMPT_MIN ||
    raw.attempts.length > PARALLEL_ATTEMPT_MAX
  )
    return undefined;
  const attempts: ParallelAttempt[] = [];
  for (const entry of raw.attempts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const attempt = entry as Record<string, unknown>;
    const state = parseAttemptState(attempt.state);
    if (
      !text(attempt.id, 16) ||
      !safeModelPreset(attempt.preset) ||
      !safeBranchName(attempt.branch) ||
      !state
    )
      return undefined;
    attempts.push({ id: attempt.id, preset: attempt.preset, branch: attempt.branch, state });
  }
  const state = parseGroupState(raw.state);
  if (!state) return undefined;
  if (
    state.kind === "adopted" &&
    !attempts.some((attempt) => attempt.id === state.attemptId)
  )
    return undefined;
  return {
    id: raw.id,
    title: raw.title,
    prompt: raw.prompt,
    workspace: raw.workspace,
    createdAt: raw.createdAt,
    attempts,
    state,
  };
}

/** One attempt's leftovers, read from Git right before it is removed. */
export interface ParallelCleanupItem {
  attemptId: string;
  branch: string;
  /** The worktree that has the branch checked out, when one does. */
  worktreePath?: string;
  /** Modified and untracked paths that removing the worktree would discard. */
  uncommittedFiles: number;
  branchExists: boolean;
  /** Commits on the branch that are on no remote and on no other local branch. */
  unpushedCommits: number;
  sessionId?: string;
}

export interface ParallelCleanupPlan {
  groupId: string;
  /** The adopted attempt's branch, which the cleanup never touches. */
  keptBranch?: string;
  items: ParallelCleanupItem[];
}

/** The native confirmation's text: every loss the cleanup can cause is named in it. */
export function parallelCleanupConfirmation(plan: ParallelCleanupPlan): {
  message: string;
  detail: string;
} {
  const lines: string[] = [];
  for (const item of plan.items) {
    lines.push(`시도 #${item.attemptId} · ${item.branch}`);
    if (item.worktreePath)
      lines.push(
        item.uncommittedFiles > 0
          ? `  worktree 삭제: ${item.worktreePath} (커밋하지 않은 변경 ${item.uncommittedFiles}개가 사라집니다)`
          : `  worktree 삭제: ${item.worktreePath}`,
      );
    if (item.branchExists)
      lines.push(
        item.unpushedCommits > 0
          ? `  브랜치 삭제: ${item.branch} (push하지 않은 커밋 ${item.unpushedCommits}개가 사라집니다)`
          : `  브랜치 삭제: ${item.branch}`,
      );
    if (item.sessionId) lines.push("  세션은 목록에서 숨깁니다. GJC의 기록은 지우지 않습니다.");
  }
  if (plan.keptBranch)
    lines.push("", `채택한 브랜치 ${plan.keptBranch}와 그 worktree는 그대로 둡니다.`);
  return {
    message: plan.keptBranch
      ? "채택하지 않은 시도를 정리할까요?"
      : "병렬 실행 시도를 모두 정리할까요?",
    detail: lines.join("\n"),
  };
}
