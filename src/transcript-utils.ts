import type { TranscriptItem } from "./backend/types";

export const MAX_CACHED_TRANSCRIPTS = 3;

export interface RecentUserRequest {
  id: string;
  text: string;
  createdAt: string;
}

/** Compact user-only history for quickly recovering a session's recent intent. */
export function recentUserRequests(
  items: readonly TranscriptItem[],
  limit = 3,
): RecentUserRequest[] {
  return items
    .filter(
      (item): item is Extract<TranscriptItem, { kind: "message" }> =>
        item.kind === "message" && item.role === "user",
    )
    .map((item) => {
      const paths = [...item.content.matchAll(/^\s*-\s+"([^"]+)"\s*$/gmu)].map(
        (match) => match[1]!.split("/").at(-1)!,
      );
      const body = item.content
        .replace(
          /<local-(?:attachments|files|images)>[\s\S]*?<\/local-(?:attachments|files|images)>/gu,
          "",
        )
        .replace(
          /Use the read tool on these local (?:paths|files) when their contents are needed\./gu,
          "",
        )
        .replace(
          /The user attached these images\. You MUST inspect every image with the read tool before responding\./gu,
          "",
        )
        .replace(/\s+/gu, " ")
        .trim();
      const text =
        body || (paths.length > 0 ? `첨부: ${paths.join(", ")}` : "첨부 요청");
      return { id: item.id, text, createdAt: item.createdAt };
    })
    .filter((item) => item.text.length > 0)
    .slice(-Math.max(0, limit))
    .reverse();
}

export function orderedSessionsForShortcuts<T extends { pinned: boolean }>(
  sessions: readonly T[],
): T[] {
  return [
    ...sessions.filter((session) => session.pinned),
    ...sessions.filter((session) => !session.pinned),
  ];
}

export function initialSessionId(
  sessions: ReadonlyArray<{ id: string; unread: boolean; title?: string }>,
  current: string | null,
): string | null {
  const selected = sessions.find((session) => session.id === current);
  const selectedIsEmptyDraft = selected?.title === "새 Gajae 세션";
  return (
    sessions.find((session) => session.unread)?.id ??
    (!selectedIsEmptyDraft ? selected?.id : undefined) ??
    sessions.find((session) => session.title !== "새 Gajae 세션")?.id ??
    selected?.id ??
    sessions[0]?.id ??
    null
  );
}

export type TranscriptBlock =
  | { kind: "item"; id: string; item: TranscriptItem }
  | {
      kind: "tools";
      id: string;
      items: Extract<TranscriptItem, { kind: "tool" }>[];
    };

/**
 * Consecutive tool calls collapse into one block so a long bash/read run costs one
 * card instead of one card per call. Any other item (message, thought, plan, notice)
 * closes the run, which keeps reasoning boundaries visible.
 */
export function groupTranscriptItems(
  items: readonly TranscriptItem[],
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      blocks.push({ kind: "item", id: item.id, item });
      continue;
    }
    const last = blocks.at(-1);
    if (last?.kind === "tools") last.items.push(item);
    else blocks.push({ kind: "tools", id: `tools-${item.id}`, items: [item] });
  }
  return blocks;
}

export function isNearTranscriptBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 48,
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

function sameUserRequest(
  remote: Extract<TranscriptItem, { kind: "message" }>,
  local: Extract<TranscriptItem, { kind: "message" }>,
): boolean {
  if (remote.content === local.content) return true;
  const remoteText = requestText(remote.content);
  const localText = requestText(local.content);
  if (remoteText && localText) return remoteText === localText;
  if (local.images?.length) {
    const remoteHasImages =
      /<local-images>/u.test(remote.content) || Boolean(remote.images?.length);
    return remoteHasImages && (!localText || remoteText === localText);
  }
  return false;
}

export function copyableMessageText(content: string): string {
  return content
    .replace(
      /<local-(?:attachments|files|images)>[\s\S]*?<\/local-(?:attachments|files|images)>/gu,
      "",
    )
    .replace(
      /Use the read tool on these local (?:paths|files) when their contents are needed\./gu,
      "",
    )
    .replace(
      /The user attached these images\. You MUST inspect every image with the read tool before responding\./gu,
      "",
    )
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function requestText(content: string): string {
  return copyableMessageText(content).replace(/\s+/gu, " ").trim();
}

export function cacheTranscript(
  transcripts: Record<string, TranscriptItem[]>,
  sessionId: string,
  items: TranscriptItem[],
  maximum = MAX_CACHED_TRANSCRIPTS,
): Record<string, TranscriptItem[]> {
  const previous = transcripts[sessionId];
  if (previous) {
    const previousRemoteIds = new Set(
      previous
        .filter((item) => !item.id.startsWith("local-user-"))
        .map((item) => item.id),
    );
    const optimistic = previous.filter(
      (item): item is Extract<TranscriptItem, { kind: "message" }> =>
        item.kind === "message" && item.id.startsWith("local-user-"),
    );
    for (const local of optimistic) {
      const confirmed = items.some(
        (item) =>
          item.kind === "message" &&
          item.role === "user" &&
          !previousRemoteIds.has(item.id) &&
          sameUserRequest(item, local),
      );
      if (!confirmed) items = [...items, local];
    }
  }
  if (previous && previous !== items) {
    let changed = previous.length !== items.length;
    items = items.map((item, index) => {
      const current = previous[index];
      if (
        current?.id === item.id &&
        JSON.stringify(current) === JSON.stringify(item)
      )
        return current;
      changed = true;
      return item;
    });
    if (!changed) items = previous;
  }
  const keys = Object.keys(transcripts);
  if (
    transcripts[sessionId] === items &&
    keys.at(-1) === sessionId &&
    keys.length <= maximum
  )
    return transcripts;

  const cached = { ...transcripts };
  delete cached[sessionId];
  cached[sessionId] = items;
  while (Object.keys(cached).length > maximum) {
    const oldest = Object.keys(cached)[0];
    if (oldest === undefined) break;
    delete cached[oldest];
  }
  return cached;
}

export function updateTranscriptItem(
  transcripts: Record<string, TranscriptItem[]>,
  sessionId: string,
  itemId: string,
  update: (item: TranscriptItem) => TranscriptItem,
): Record<string, TranscriptItem[]> {
  const items = transcripts[sessionId];
  if (!items) return transcripts;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].id !== itemId) continue;

    const updatedItem = update(items[index]);
    if (updatedItem === items[index]) return transcripts;

    const updatedItems = items.slice();
    updatedItems[index] = updatedItem;
    return { ...transcripts, [sessionId]: updatedItems };
  }

  return transcripts;
}

/**
 * Discovery only reports identity and workspace. Local runtime state (status,
 * phase, model, usage) is authoritative while a session is open, so a refresh
 * adds newly discovered sessions and drops closed ones without overwriting the
 * live rows this window already tracks.
 */
export function mergeDiscoveredSessions<
  T extends { id: string; unread: boolean; status?: string },
>(current: readonly T[], discovered: readonly T[]): T[] {
  const known = new Map(current.map((session) => [session.id, session]));
  const discoveredIds = new Set(discovered.map((session) => session.id));
  // A session being created locally is not discoverable yet, so it survives a
  // refresh. Anything else discovery stopped reporting is gone and must leave
  // the list instead of lingering as a dead row.
  const pendingLocal = current.filter(
    (session) =>
      !discoveredIds.has(session.id) &&
      (session.status === "starting" || session.status === "failed"),
  );
  const merged = discovered.map((session) => {
    const existing = known.get(session.id);
    return existing ? { ...session, ...existing } : session;
  });
  return [...pendingLocal, ...merged];
}
