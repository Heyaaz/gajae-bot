import type { AgentSession } from "../backend/types";

/**
 * The list is split by what the session is doing for the user rather than by
 * pinning alone: work that stopped to ask for approval is the reason the rail is
 * looked at, so it leads the list instead of sitting wherever recency put it.
 */
export type SessionGroupId = "needs-input" | "working" | "completed";

export const SESSION_GROUP_ORDER: readonly SessionGroupId[] = [
  "needs-input",
  "working",
  "completed",
];

export const SESSION_GROUP_LABELS: Record<SessionGroupId, string> = {
  "needs-input": "확인 필요",
  working: "작업 중",
  completed: "완료",
};

/** Rows a group shows before the rest move behind 더 보기. */
export const SESSION_GROUP_LIMIT = 5;

/** Rows that can carry a ⌘ digit: the main process maps ⌘1-⌘9 to these. */
export const SESSION_SHORTCUT_LIMIT = 9;

export function sessionGroupOf(
  session: Pick<AgentSession, "status" | "phase">,
): SessionGroupId {
  // Compaction outlives the turn that started it, so a session reported idle
  // while its context is still being compacted is doing work. Ranking it 완료 put
  // the row in a finished group a moment before it moved back out.
  if (session.phase === "compacting") return "working";
  // There is no "it failed" group: a failure is something the user has to look
  // at, which is the same job as an approval request.
  if (session.status === "failed" || session.status === "waiting")
    return "needs-input";
  if (session.status === "running" || session.status === "starting")
    return "working";
  return "completed";
}

/**
 * Newest first.
 *
 * `updatedAt` is a display label ("now", "8m", "2h"), so it cannot be compared;
 * `updatedAtMs` is the sortable twin a row carries when the backend knows when it
 * changed. Rows without one keep the relative order the backend sent instead of
 * being collected at one end, which is what a comparator returning 0 does under
 * the spec's stable sort.
 */
export function byRecency(left: AgentSession, right: AgentSession): number {
  const one = left.updatedAtMs;
  const other = right.updatedAtMs;
  if (
    typeof one !== "number" ||
    !Number.isFinite(one) ||
    typeof other !== "number" ||
    !Number.isFinite(other)
  )
    return 0;
  return other - one;
}

export interface SessionGroupBlock {
  id: SessionGroupId;
  label: string;
  sessions: AgentSession[];
  /** Rows this group is holding back, 0 when everything fits. */
  overflow: number;
}

export interface SessionListModel {
  pinned: AgentSession[];
  groups: SessionGroupBlock[];
  /** Rows in ⌘-digit order. */
  shortcuts: AgentSession[];
}

export interface SessionListOptions {
  /** Groups the user opened with 더 보기. */
  expanded?: ReadonlySet<SessionGroupId>;
  limit?: number;
}

export function sessionListModel(
  sessions: readonly AgentSession[],
  { expanded, limit = SESSION_GROUP_LIMIT }: SessionListOptions = {},
): SessionListModel {
  const pinned = sessions
    .filter((session) => session.pinned)
    .slice()
    .sort(byRecency);
  const groups: SessionGroupBlock[] = [];
  // Digits are assigned from the collapsed list: a group opened with 더 보기 adds
  // rows to the rail without renumbering the ones already numbered, so ⌘3 keeps
  // opening the row the user learned.
  const shortcuts: AgentSession[] = [...pinned];
  for (const id of SESSION_GROUP_ORDER) {
    const members = sessions
      .filter((session) => !session.pinned && sessionGroupOf(session) === id)
      .slice()
      .sort(byRecency);
    if (members.length === 0) continue;
    shortcuts.push(...members.slice(0, limit));
    groups.push({
      id,
      label: SESSION_GROUP_LABELS[id],
      sessions: expanded?.has(id) ? members : members.slice(0, limit),
      overflow: Math.max(0, members.length - limit),
    });
  }
  return {
    pinned,
    groups,
    shortcuts: shortcuts.slice(0, SESSION_SHORTCUT_LIMIT),
  };
}
