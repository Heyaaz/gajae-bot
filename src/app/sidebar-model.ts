import type { AgentSession } from "../backend/types";
import { sessionAttentionGroup } from "../../shared/desktop-integration";

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
  "needs-input": "Needs input",
  working: "Working",
  completed: "Done",
};

/** Rows a group shows before the rest move behind 더 보기. */
export const SESSION_GROUP_LIMIT = 5;

/** Rows that can carry a ⌘ digit: the main process maps ⌘1-⌘9 to these. */
export const SESSION_SHORTCUT_LIMIT = 9;

/**
 * How far a fork chain is followed before it stops being a family.
 *
 * The chain is written by hand-editable JSON, so a pair of envelopes that name each
 * other has to end somewhere rather than nesting forever.
 */
const FAMILY_DEPTH_LIMIT = 32;

/** The rail's grouping is the shared attention rule, so the Dock badge agrees with it. */
export function sessionGroupOf(
  session: Pick<AgentSession, "status" | "phase">,
): SessionGroupId {
  return sessionAttentionGroup(session);
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

/** What a collapsed family is holding back, most actionable count first. */
export interface SessionFamilySummary {
  /** Hidden members that stopped on a failure. */
  failed: number;
  /** Hidden members with activity the user has not seen. */
  unread: number;
  /** Hidden members that are working. */
  working: number;
}

export interface SessionRowNode {
  session: AgentSession;
  /** 0 for a root or a family head, 1+ for a member nested under its head. */
  depth: number;
  /** True when this row has family members it can open and close. */
  familyHead: boolean;
  /** Members this collapsed head is holding back, 0 when it is open or a leaf. */
  hidden: number;
  /** What those members are, so the head row can say it without their rows. */
  hiddenSummary: SessionFamilySummary | null;
}

export interface SessionGroupBlock {
  id: SessionGroupId;
  label: string;
  /**
   * The rows to render, in order: family heads followed by the members they are
   * showing, then single sessions.
   */
  rows: SessionRowNode[];
  /**
   * Roots this group is not showing. An opened group keeps the count of roots
   * past the cap, so the control that closes it again stays reachable.
   */
  overflow: number;
}

export interface SessionListModel {
  /** Pinned families, head first; a pin brings its forks with it. */
  pinned: SessionRowNode[];
  groups: SessionGroupBlock[];
  /** Rows in ⌘-digit order. */
  shortcuts: AgentSession[];
}

export interface SessionListOptions {
  /** Groups the user opened with 더 보기. */
  expanded?: ReadonlySet<SessionGroupId>;
  /**
   * Families the user closed. A fork is shown under the session it came from until
   * it is closed, which is what the nesting is for; closing is the exception.
   */
  collapsedFamilies?: ReadonlySet<string>;
  limit?: number;
  /** The row the user is reading, which neither a closed family nor the cap hides. */
  selectedId?: string | null;
}

interface FamilyLayout {
  /** Head id -> its members, parent before its own children, newest first. */
  members: Map<string, AgentSession[]>;
  /** Member id -> the head it hangs under. */
  headOf: Map<string, string>;
  /** Row id -> the parent it was forked from, when that parent is in this list. */
  parentOf: Map<string, string>;
  /** Parent id -> the rows forked from it, newest first. */
  childrenOf: Map<string, AgentSession[]>;
}

/** Every row forked below a head, parent before its own children, newest first. */
function descendantsOf(
  childrenOf: ReadonlyMap<string, readonly AgentSession[]>,
  head: string,
): AgentSession[] {
  const ordered: AgentSession[] = [];
  const visited = new Set([head]);
  const walk = (parent: string): void => {
    for (const child of childrenOf.get(parent) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      ordered.push(child);
      walk(child.id);
    }
  };
  walk(head);
  return ordered;
}

/**
 * Links rows to the session they were forked from.
 *
 * A row whose parent is not in this list -- filtered out, or simply older than the
 * window -- stays top-level instead of hanging under a head that is not rendered.
 * Chains flatten onto one head: a fork of a fork belongs to the same family, which
 * is what keeps a family from splitting across groups. Which section draws that
 * family, and whether a pin in the middle of it redraws the branch, is decided per
 * section by the caller.
 */
function familyLayout(rows: readonly AgentSession[]): FamilyLayout {
  const byId = new Map(rows.map((session) => [session.id, session]));
  const parentOf = new Map<string, string>();
  for (const session of rows) {
    const parentId = session.parentId;
    if (!parentId || parentId === session.id || !byId.has(parentId)) continue;
    parentOf.set(session.id, parentId);
  }
  const headOf = new Map<string, string>();
  for (const id of parentOf.keys()) {
    let head = id;
    let cyclic = false;
    const seen = new Set([id]);
    for (let step = 0; step < FAMILY_DEPTH_LIMIT; step += 1) {
      const parent = parentOf.get(head);
      if (!parent) break;
      if (seen.has(parent)) {
        // Two envelopes naming each other have no head between them, so both stay
        // where they are instead of each becoming the other's child.
        cyclic = true;
        break;
      }
      seen.add(parent);
      head = parent;
    }
    if (!cyclic && head !== id) headOf.set(id, head);
  }
  const childrenOf = new Map<string, AgentSession[]>();
  for (const [id, parent] of parentOf) {
    const session = byId.get(id);
    if (session)
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), session]);
  }
  for (const children of childrenOf.values()) children.sort(byRecency);
  const members = new Map<string, AgentSession[]>();
  for (const head of headOf.values()) {
    if (members.has(head)) continue;
    members.set(head, descendantsOf(childrenOf, head));
  }
  return { childrenOf, headOf, members, parentOf };
}

function depthOf(
  session: AgentSession,
  head: string,
  rows: ReadonlyMap<string, AgentSession>,
): number {
  let depth = 1;
  let cursor = session;
  const seen = new Set([session.id]);
  while (cursor.parentId && cursor.parentId !== head) {
    const parent = rows.get(cursor.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    cursor = parent;
    depth += 1;
  }
  return depth;
}

function summarize(members: readonly AgentSession[]): SessionFamilySummary {
  return {
    failed: members.filter((session) => session.status === "failed").length,
    unread: members.filter((session) => session.unread).length,
    working: members.filter((session) => sessionGroupOf(session) === "working")
      .length,
  };
}

export function sessionListModel(
  sessions: readonly AgentSession[],
  {
    expanded,
    collapsedFamilies,
    limit = SESSION_GROUP_LIMIT,
    selectedId,
  }: SessionListOptions = {},
): SessionListModel {
  const pinnedSessions = sessions
    .filter((session) => session.pinned)
    .slice()
    .sort(byRecency);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  // Families are resolved across the whole list before it splits into sections: a
  // pinned head has to be able to bring its forks with it, and whether a section
  // owns a family cannot be decided one section at a time.
  const { childrenOf, headOf, members, parentOf } = familyLayout(sessions);
  // A pin is a move to the top of the rail, so it takes the forks below it: the
  // descendants of a -> pinned b -> c render under b rather than waiting at depth 2
  // under a head whose fork is no longer beside them. A row outside the layout -- a
  // cycle, or a parent this list never had -- has no family to inherit, so its pin
  // moves the one row it always did.
  const pinnedFamilies = new Map<string, AgentSession[]>();
  for (const session of pinnedSessions) {
    if (!headOf.has(session.id) && !members.has(session.id)) continue;
    const family = descendantsOf(childrenOf, session.id);
    if (family.length > 0) pinnedFamilies.set(session.id, family);
  }
  /**
   * The pinned row a row renders under: itself when it owns a family, the pinned
   * ancestor that took it along when it sits below one, null when no pin owns it.
   */
  const pinnedBranchOf = (sessionId: string): string | null => {
    let branch = pinnedFamilies.has(sessionId) ? sessionId : null;
    let cursor = sessionId;
    const seen = new Set([sessionId]);
    for (let step = 0; step < FAMILY_DEPTH_LIMIT; step += 1) {
      const parent = parentOf.get(cursor);
      if (!parent || seen.has(parent)) break;
      seen.add(parent);
      // The outermost pin owns the branch: a pinned fork below a pinned head stays
      // inside that head's family instead of splitting the branch across two rows.
      if (pinnedFamilies.has(parent)) branch = parent;
      cursor = parent;
    }
    return branch;
  };
  const claimedByPinnedBranch = (sessionId: string): boolean => {
    const branch = pinnedBranchOf(sessionId);
    return branch !== null && branch !== sessionId;
  };
  /** The rows a family renders as: its head, then the members it is showing. */
  const familyNodes = (
    root: AgentSession,
    family: readonly AgentSession[],
  ): SessionRowNode[] => {
    const open = !collapsedFamilies?.has(root.id);
    // A closed family never hides the row the user is reading, or the approval it is
    // waiting on. Everything else waits behind the count on the head.
    const kept = family.filter(
      (member) => member.id === selectedId || member.status === "waiting",
    );
    const visible = open ? family : kept;
    const hidden = open
      ? []
      : family.filter((member) => !visible.includes(member));
    const nodes: SessionRowNode[] = [
      {
        session: root,
        depth: 0,
        familyHead: family.length > 0,
        hidden: hidden.length,
        hiddenSummary: hidden.length > 0 ? summarize(hidden) : null,
      },
    ];
    for (const member of visible)
      nodes.push({
        session: member,
        depth: depthOf(member, root.id, byId),
        familyHead: false,
        hidden: 0,
        hiddenSummary: null,
      });
    return nodes;
  };

  const pinned: SessionRowNode[] = [];
  const shortcuts: AgentSession[] = [];
  for (const session of pinnedSessions) {
    // A pin nested below another pin renders inside that branch: its head draws it.
    if (claimedByPinnedBranch(session.id)) continue;
    shortcuts.push(session);
    pinned.push(...familyNodes(session, pinnedFamilies.get(session.id) ?? []));
  }

  // A family is placed by its most actionable member, and every member lands in that
  // group: a working child is why its completed parent is worth looking at, and
  // splitting them across groups would hide the relationship the nesting exists to
  // show. Pinned members are left out, and so are the forks a pinned row took with
  // it: both render in the pinned section and cannot be the reason a group is placed.
  const familyGroup = new Map<string, SessionGroupId>();
  for (const [head, family] of members) {
    const headSession = byId.get(head);
    if (!headSession) continue;
    familyGroup.set(
      head,
      [
        headSession,
        ...family.filter(
          (session) => !session.pinned && !claimedByPinnedBranch(session.id),
        ),
      ]
        .map(sessionGroupOf)
        .reduce((best, group) =>
          SESSION_GROUP_ORDER.indexOf(group) < SESSION_GROUP_ORDER.indexOf(best)
            ? group
            : best,
        ),
    );
  }
  const groupOf = (session: AgentSession): SessionGroupId => {
    // A head answers for itself as well: the family it leads is placed by its most
    // actionable member, and the head is one of them.
    const head = headOf.get(session.id) ?? session.id;
    return familyGroup.get(head) ?? sessionGroupOf(session);
  };

  const groups: SessionGroupBlock[] = [];
  for (const id of SESSION_GROUP_ORDER) {
    const roots = sessions
      .filter(
        (session) =>
          !session.pinned &&
          !claimedByPinnedBranch(session.id) &&
          !headOf.has(session.id) &&
          groupOf(session) === id,
      )
      .slice()
      .sort(byRecency);
    if (roots.length === 0) continue;
    // Digits are assigned from the collapsed list: a group opened with 더 보기 adds
    // rows to the rail without renumbering the ones already numbered, so ⌘3 keeps
    // opening the row the user learned. A family is one digit, wherever it is open.
    const capped = roots.slice(0, limit);
    shortcuts.push(...capped);
    const opened = expanded?.has(id) ?? false;
    const familyOf = (root: AgentSession): AgentSession[] =>
      (members.get(root.id) ?? []).filter(
        (member) => !member.pinned && !claimedByPinnedBranch(member.id),
      );
    // The row the user is reading is never behind 더 보기: the cap decides which
    // families the group leads with, not whether the open session is on the rail.
    // The kept family renders after the capped roots, so the rows the digits point
    // at keep their order and nothing beyond the cap takes a digit of its own.
    const kept =
      opened || !selectedId
        ? []
        : roots
            .slice(limit)
            .filter(
              (root) =>
                root.id === selectedId ||
                familyOf(root).some((member) => member.id === selectedId),
            );
    const shown = opened ? roots : [...capped, ...kept];
    const nodes: SessionRowNode[] = [];
    for (const root of shown) nodes.push(...familyNodes(root, familyOf(root)));
    groups.push({
      id,
      label: SESSION_GROUP_LABELS[id],
      rows: nodes,
      // An opened group keeps the cap's count so the 접기 control stays reachable.
      overflow: opened
        ? Math.max(0, roots.length - limit)
        : roots.length - shown.length,
    });
  }
  return {
    pinned,
    groups,
    shortcuts: shortcuts.slice(0, SESSION_SHORTCUT_LIMIT),
  };
}
