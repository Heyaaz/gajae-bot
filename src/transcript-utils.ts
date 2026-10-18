import type { TranscriptItem } from "./backend/types";

export const MAX_CACHED_TRANSCRIPTS = 3;

export function parseSkillInvocation(text: string): { name: string; args: string } | undefined {
  const match = /^\/skill:([\p{L}\p{N}][\p{L}\p{N}_.-]*)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return undefined;
  return { name: match[1], args: match[2]?.trim() ?? "" };
}

export interface RecentUserRequest {
  id: string;
  text: string;
  createdAt: string;
}

// A user row is immutable once it lands, so its compact text is derived once even
// while assistant deltas keep replacing the array around it.
const recentRequestCache = new WeakMap<TranscriptItem, RecentUserRequest | null>();

function recentUserRequest(
  item: Extract<TranscriptItem, { kind: "message" }>,
): RecentUserRequest | undefined {
  const cached = recentRequestCache.get(item);
  if (cached !== undefined) return cached ?? undefined;
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
  const request = text.length > 0 ? { id: item.id, text, createdAt: item.createdAt } : null;
  recentRequestCache.set(item, request);
  return request ?? undefined;
}

/**
 * Compact user-only history for quickly recovering a session's recent intent.
 *
 * Reads backwards and stops once `limit` requests are found. The previous
 * filter/map walked and parsed every user row in the conversation on each
 * streamed chunk, which made the strip's cost grow with the session length.
 */
export function recentUserRequests(
  items: readonly TranscriptItem[],
  limit = 3,
): RecentUserRequest[] {
  const wanted = Math.max(0, limit);
  if (wanted === 0) return [];
  const requests: RecentUserRequest[] = [];
  for (let index = items.length - 1; index >= 0 && requests.length < wanted; index -= 1) {
    const item = items[index];
    if (item.kind !== "message" || item.role !== "user") continue;
    const request = recentUserRequest(item);
    if (request) requests.push(request);
  }
  return requests;
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
 * The most tool cards one virtual row may render.
 *
 * Collapsing a run into a single block saved card overhead but made a long run one
 * row: the virtualizer rendered every call inside it, so the number of mounted cards
 * no longer followed the viewport. A bounded chunk keeps the grouping and restores
 * that bound; a run of hundreds of calls becomes several measurable rows.
 */
export const TOOL_GROUP_LIMIT = 20;

/**
 * Consecutive tool calls collapse into blocks of at most TOOL_GROUP_LIMIT so a long
 * bash/read run costs one row per chunk instead of one row per call. Any other item
 * (message, thought, plan, notice) closes the run, which keeps reasoning boundaries
 * visible.
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
    if (last?.kind === "tools" && last.items.length < TOOL_GROUP_LIMIT)
      last.items.push(item);
    else blocks.push({ kind: "tools", id: `tools-${item.id}`, items: [item] });
  }
  return blocks;
}

export interface ToolRunSummary {
  /** Number of command (bash-like) tool calls in the run. */
  commandCount: number;
  /** Number of distinct files touched by an edit/write tool carrying a diff. */
  fileCount: number;
  added: number;
  removed: number;
  failedCount: number;
  approvalRequiredCount: number;
  /** True when every call in the run finished without failure or denial. */
  allCompleted: boolean;
}

function toolDiffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * One-line summary for a collapsed tool-run block, e.g. "명령 3개 실행 · 파일 2개
 * 수정 (+12 −3) · 1개 실패".
 *
 * A run with any failed or approval-required call is reported distinctly so the
 * collapsed summary itself tells the user something needs attention, without
 * requiring the block to expand first.
 */
export function summarizeToolRun(
  items: readonly Extract<TranscriptItem, { kind: "tool" }>[],
): ToolRunSummary {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  let commandCount = 0;
  let failedCount = 0;
  let approvalRequiredCount = 0;
  for (const item of items) {
    if (item.diff && item.targetPath) {
      files.add(item.targetPath);
      const counts = toolDiffCounts(item.diff);
      added += counts.added;
      removed += counts.removed;
    } else {
      commandCount += 1;
    }
    if (item.status === "failed" || item.status === "denied") failedCount += 1;
    if (item.status === "approval-required") approvalRequiredCount += 1;
  }
  return {
    commandCount,
    fileCount: files.size,
    added,
    removed,
    failedCount,
    approvalRequiredCount,
    allCompleted: failedCount === 0 && approvalRequiredCount === 0,
  };
}

/**
 * Tool calls currently waiting on an approval decision, in transcript order.
 *
 * The sticky approval banner needs this independent of whichever blocks the
 * virtualizer happens to have mounted: a card the user scrolled away from is still
 * waiting, and the banner is what keeps it reachable.
 */
export function pendingToolApprovals(
  items: readonly TranscriptItem[],
): Extract<TranscriptItem, { kind: "tool" }>[] {
  return items.filter(
    (item): item is Extract<TranscriptItem, { kind: "tool" }> =>
      item.kind === "tool" && item.status === "approval-required",
  );
}

/**
 * Which blocks open a new turn, for a wider visual gap between a user's request and
 * the previous turn's response.
 *
 * A block opens a turn when it is a user message. A block right after a non-tool,
 * non-message item (a notice, for instance) is deliberately not marked: only a user
 * request is a turn boundary, so a run of system furniture between two assistant
 * replies does not read as one.
 */
export function turnStartBlockIds(
  blocks: readonly TranscriptBlock[],
): ReadonlySet<string> {
  const starts = new Set<string>();
  for (const block of blocks) {
    if (
      block.kind === "item" &&
      block.item.kind === "message" &&
      block.item.role === "user"
    ) {
      starts.add(block.id);
    }
  }
  return starts;
}

/**
 * Locates the block holding an item so the transcript can scroll to a search hit.
 *
 * Only a window of blocks is mounted, so a hit is usually not in the DOM and cannot be
 * found by id. Its index is what the virtualizer needs to bring it on screen first.
 * Returns -1 when the item is absent.
 */
export function transcriptBlockIndexForItem(
  blocks: readonly TranscriptBlock[],
  itemId: string,
): number {
  return blocks.findIndex((block) =>
    block.kind === "item"
      ? block.item.id === itemId
      : block.items.some((item) => item.id === itemId),
  );
}

export function isNearTranscriptBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 48,
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

/**
 * Scroll intent carried between input and the resulting scroll events.
 *
 * Chromium reports negative wheel delta while this transcript moves toward older
 * content and positive delta while it moves toward the latest content. Direction
 * reversal matters immediately: keeping an earlier upward intent until an exact
 * 0-1px landing leaves the follow chip stuck when smooth scrolling or virtual row
 * measurement stops a few pixels short of the mathematical bottom.
 */
export function transcriptScrollIntent(
  scrolledAway: boolean,
  deltaY: number,
): boolean {
  if (deltaY < 0) return true;
  if (deltaY > 0) return false;
  return scrolledAway;
}

/**
 * Whether the transcript should keep pinning itself to the newest content.
 *
 * Distance alone cannot answer this. Rows above the viewport are unmounted, so the
 * scroll height is an estimate and a drag to the end can land a couple hundred
 * pixels short -- that has to read as following, or the view stalls with a blank
 * band under the newest message. But one wheel notch is only ~109px, which lands
 * in that same band, and treating it as following pulled the view straight back
 * down: a small scroll up produced no net movement at all.
 *
 * So intent is the second input. Once the user has scrolled away in this gesture,
 * any distance from the bottom means they are reading and following stops. The
 * slack applies only when they have not, which is exactly the case it exists for.
 * Returning to the bottom re-arms following either way.
 */
export function shouldFollowTranscript(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  scrolledAway: boolean,
  // A full viewport, because the estimation error is the only thing this slack has
  // to cover once intent is accounted for: a measured drag to the end landed 577px
  // short on a real session. A third of a viewport was the old compromise, chosen to
  // stop small scrolls snapping back, which `scrolledAway` now handles directly.
  threshold = clientHeight,
): boolean {
  const remaining = scrollHeight - scrollTop - clientHeight;
  if (scrolledAway) return remaining <= 1;
  return remaining < threshold;
}

function sameUserRequest(
  remote: Extract<TranscriptItem, { kind: "message" }>,
  local: Extract<TranscriptItem, { kind: "message" }>,
): boolean {
  if (remote.content === local.content) return true;
  const remoteText = requestText(remote.content);
  const localText = requestText(local.content);
  if (remoteText && localText) return remoteText === localText;
  // An attachment-only request has no prose on either side, so text comparison
  // cannot confirm it. The attached file names are the only content both sides
  // carry, so they stand in for the body.
  const remoteNames = attachedNames(remote.content);
  const localNames =
    attachedNames(local.content) ||
    (local.images ?? []).map((image) => image.name).sort().join("|");
  if (!remoteText && !localText && (remoteNames || localNames))
    return remoteNames === localNames;
  if (local.images?.length) {
    const remoteHasImages =
      /<local-images>/u.test(remote.content) || Boolean(remote.images?.length);
    return remoteHasImages && (!localText || remoteText === localText);
  }
  return false;
}

/**
 * Names of the files and images a prompt attached, in the order they were attached.
 *
 * The paths live in a block addressed to the agent, and the bubble strips that block
 * so the instructions do not read as the user's own words. That left an attachment
 * invisible: a thumbnail alone does not say a file was sent, and an image the model
 * read by path had nothing to show at all. The renderer lists these names next to the
 * message so the user can see what went with it.
 */
export function attachmentSummaryText(content: string): string[] {
  const blocks = content.matchAll(
    /<local-(?:attachments|files|images)>([\s\S]*?)<\/local-(?:attachments|files|images)>/gu,
  );
  const names: string[] = [];
  for (const block of blocks)
    for (const line of block[1]!.matchAll(/^\s*-\s+"([^"]+)"\s*$/gmu))
      names.push(line[1]!.split("/").at(-1)!);
  return names;
}

/** File names from a prompt's attachment block, order-independent. */
function attachedNames(content: string): string {
  return [...content.matchAll(/^\s*-\s+"([^"]+)"\s*$/gmu)]
    .map((match) => match[1]!.split("/").at(-1)!)
    .sort()
    .join("|");
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

// A user bubble the app rendered itself, before GJC confirmed the request. The
// controller echoes prompts and steers as `local-prompt-`, and such a row has to
// survive a transcript sync until a matching remote message arrives, or a
// just-sent message disappears mid-turn.
function isLocalEcho(id: string): boolean {
  return id.startsWith("local-prompt-");
}

export function cacheTranscript(
  transcripts: Record<string, TranscriptItem[]>,
  sessionId: string,
  items: TranscriptItem[],
  maximum = MAX_CACHED_TRANSCRIPTS,
): Record<string, TranscriptItem[]> {
  const previous = transcripts[sessionId];
  if (previous) {
    // A full sync rebuilds every row from the persisted transcript, which never
    // stores the inline image bytes. Carry them from the row this window already
    // shows with the same id, or a refresh would blank every thumbnail.
    const earlierMessages = new Map(
      previous
        .filter(
          (item): item is Extract<TranscriptItem, { kind: "message" }> =>
            item.kind === "message" && item.role === "user",
        )
        .map((item) => [item.id, item]),
    );
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind !== "message" || item.role !== "user" || item.images?.length)
        continue;
      const earlier = earlierMessages.get(item.id);
      const carried = earlier ? withLocalImages(item, earlier) : item;
      if (carried === item) continue;
      items = items.slice();
      items[index] = carried;
    }
    const optimistic = previous.filter(
      (item): item is Extract<TranscriptItem, { kind: "message" }> =>
        item.kind === "message" && isLocalEcho(item.id),
    );
    // Each remote user message confirms at most one echo. Matching by text alone
    // let a single remote row confirm nothing when it was already on screen
    // before the echo -- the old "must be a newly seen id" rule -- which left the
    // echo pinned forever and rendered the request twice. Consuming candidates
    // instead keeps two identical requests independent while guaranteeing every
    // confirmed echo is dropped.
    const consumed = new Set<number>();
    for (const local of optimistic) {
      // A repeated request has to keep its position in the sequence. Matching
      // the first row with the same text consumed an older historical request
      // and left the new row without its images. Count the identical user rows
      // before this echo, then confirm the echo against the same occurrence in
      // the persisted transcript.
      const localIndex = previous.indexOf(local);
      let occurrence = 0;
      for (let index = 0; index < localIndex; index += 1) {
        const earlier = previous[index];
        if (
          earlier?.kind === "message" &&
          earlier.role === "user" &&
          sameUserRequest(earlier, local)
        )
          occurrence += 1;
      }
      const candidates = items.flatMap((item, index) =>
        item.kind === "message" &&
        item.role === "user" &&
        !isLocalEcho(item.id) &&
        sameUserRequest(item, local)
          ? [index]
          : [],
      );
      // A rescan can republish fewer rows than the window shows (the confirming
      // row was already on screen); in that case the echo retires against the
      // newest available occurrence instead of staying pinned forever.
      let match = candidates[occurrence] ?? candidates.at(-1) ?? -1;
      if (match >= 0 && consumed.has(match))
        match = [...candidates].reverse().find((index) => !consumed.has(index)) ?? -1;
      if (match < 0) {
        items = [...items, local];
        continue;
      }
      consumed.add(match);
      // The persisted row is the only one left, and it arrives without the
      // images this window rendered. Confirm the echo by retiring it, but keep
      // what it displayed on the row that replaces it. Consuming matches one by
      // one also keeps two identical requests from sharing one request's images.
      items = items.slice();
      items[match] = withLocalImages(items[match], local);
    }
  }
  if (previous && previous !== items) {
    // Appending a row leaves every earlier row reference-identical. Walking that
    // prefix without serialising each one keeps the cost of a streamed chunk
    // proportional to the new row, not to the whole conversation. A full sync can
    // rebuild rows as new objects; each content-equal row independently keeps its
    // previous identity so one changed row does not invalidate every memoised row.
    const shared = Math.min(previous.length, items.length);
    let prefixSame = true;
    let reused: TranscriptItem[] | undefined;
    for (let index = 0; index < shared; index += 1) {
      const current = previous[index];
      const item = items[index];
      const same = current === item;
      const equivalent =
        same ||
        (current?.id === item.id &&
          JSON.stringify(current) === JSON.stringify(item));
      if (!equivalent) prefixSame = false;
      if (reused) {
        reused.push(equivalent ? current : item);
      } else if (equivalent && !same) {
        reused = items.slice(0, index);
        reused.push(current);
      }
    }
    if (prefixSame) {
      if (previous.length === items.length) items = previous;
      // Only a longer list is an append; a shorter one dropped rows and must not
      // resurrect them from the previous array.
      else if (items.length > previous.length)
        items = [...previous, ...items.slice(shared)];
      else if (reused) {
        reused.push(...items.slice(shared));
        items = reused;
      }
    } else if (reused) {
      reused.push(...items.slice(shared));
      items = reused;
    }
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

/**
 * Merge a single published item into a session's history.
 *
 * A transcript rescan republishes a row once its status or output changes, so an
 * id that is already present is replaced rather than appended -- appending it
 * again showed the same tool call twice.
 */
export function mergeTranscriptItem(
  items: readonly TranscriptItem[],
  item: TranscriptItem,
): TranscriptItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    if (supersedesRunningTool(items[index], item)) return items.slice();
    return items.map((existing, at) => (at === index ? item : existing));
  }
  // Every row this window shows before GJC persists it carries a local id, and
  // the persisted rebuild of that same row carries a different one. An id-only
  // match treated the rebuild as a brand new row and appended it, so a request,
  // a reply, or a cancellation notice rendered twice.
  const superseded = supersededLocalIndex(items, item);
  if (superseded >= 0)
    return items.map((existing, at) =>
      at === superseded ? withLocalImages(item, existing) : existing,
    );
  return [...items, item];
}

/**
 * True when a rebuilt tool row would undo a live one without knowing any better.
 *
 * The live connection reports a tool call the moment it starts and again when it ends. A
 * transcript rescan rebuilds the same row from the persisted file, and the broker writes no
 * status on a tool block at all -- verified against a live session: 55 blocks, none with
 * one. So a call still in flight comes back carrying only the fact that no result was
 * recorded, which the rebuild reports as a settled state. Applying that put a tool card
 * into a finished state while the tool was still working.
 *
 * A rebuild carrying a real outcome -- output, a failure -- is newer than the live report
 * and still replaces it.
 */
function supersedesRunningTool(
  existing: TranscriptItem,
  incoming: TranscriptItem,
): boolean {
  if (existing.kind !== "tool" || incoming.kind !== "tool") return false;
  if (existing.status !== "running" && existing.status !== "pending")
    return false;
  // The state the rebuild invents for a call whose outcome is absent from the file.
  // Anything else, including completed with output or failed, is real news.
  return incoming.status === "cancelled" && !incoming.output;
}

/**
 * Carries a replaced row's inline images onto its persisted rebuild.
 *
 * Only this window ever holds the image bytes: the app reads the file and echoes the
 * bubble with inline base64, while the persisted transcript stores the path inside the
 * prompt text and nothing else. So the rebuild always arrives without images, and
 * replacing the row wholesale erased the thumbnail the user had just seen.
 */
function withLocalImages(
  item: TranscriptItem,
  replaced: TranscriptItem,
): TranscriptItem {
  if (item.kind !== "message" || replaced.kind !== "message") return item;
  if (item.images?.length || !replaced.images?.length) return item;
  return { ...item, images: replaced.images };
}

// Local ids and the persisted ids that replace them. The renderer draws whatever
// the transcript holds, so a rebuilt row must retire the local copy of itself
// rather than sit next to it. `gjc-message-` is what the controller names a
// streamed reply, so it is the prefix a persisted rebuild has to match: an entry
// for an id nothing writes leaves the streamed copy behind and the reply draws
// twice.
const LOCAL_MESSAGE_PREFIXES = ["gjc-message-", "local-prompt-"];
const LOCAL_NOTICE_PREFIXES = ["gjc-cancelled-"];

function hasLocalPrefix(id: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => id.startsWith(prefix));
}

/** Index of the locally rendered row that `item` is the persisted rebuild of. */
function supersededLocalIndex(
  items: readonly TranscriptItem[],
  item: TranscriptItem,
): number {
  if (item.kind === "message" && item.id.startsWith("shared-message-")) {
    const body = requestText(item.content);
    if (!body) return -1;
    return items.findIndex(
      (existing) =>
        existing.kind === "message" &&
        existing.role === item.role &&
        hasLocalPrefix(existing.id, LOCAL_MESSAGE_PREFIXES) &&
        requestText(existing.content) === body,
    );
  }
  // A cancelled turn is announced locally the moment the user aborts, and the
  // persisted transcript reports the same stop as its own notice row.
  if (item.kind === "notice" && item.id.startsWith("shared-cancelled-")) {
    return items.findIndex(
      (existing) =>
        existing.kind === "notice" &&
        hasLocalPrefix(existing.id, LOCAL_NOTICE_PREFIXES) &&
        existing.title === item.title,
    );
  }
  return -1;
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
 * Merges a discovery refresh into the rows already on screen.
 *
 * Local runtime state (phase, model, usage) is authoritative while a session is
 * open, so a refresh adds newly discovered sessions and drops closed ones without
 * overwriting what this window tracks. `status` is the exception: discovery now
 * derives it from the session's transcript, which is the only account of work this
 * window is not driving. Keeping the on-screen value there pinned a row to the
 * state it happened to be listed in, so an agent working in another process stayed
 * on 완료 for its whole run.
 */
/** Whether a discovered row's run revision may drive run-state observation. */
export function discoveryRevisionIsFresh(
  knownRevision: number | undefined,
  discoveredRevision: number | undefined,
): boolean {
  return (discoveredRevision ?? 0) >= (knownRevision ?? 0);
}

export function mergeDiscoveredSessions<
  T extends {
    id: string;
    unread: boolean;
    status?: string;
    runRevision?: number;
  },
>(
  current: readonly T[],
  discovered: readonly T[],
  protectedId?: string | null,
): T[] {
  const known = new Map(current.map((session) => [session.id, session]));
  const discoveredIds = new Set(discovered.map((session) => session.id));
  // A session being created locally is not discoverable yet, so it survives a
  // refresh. The focused session is kept too: a refresh that momentarily misses
  // it would otherwise drop the open conversation and move focus elsewhere.
  // Anything else discovery stopped reporting is gone and must leave the list
  // instead of lingering as a dead row.
  const retained = current.filter(
    (session) =>
      !discoveredIds.has(session.id) &&
      (session.status === "starting" ||
        session.status === "failed" ||
        session.id === protectedId),
  );
  const merged = discovered.map((session) => {
    const existing = known.get(session.id);
    if (!existing) return session;
    const currentRevision = existing.runRevision ?? 0;
    const discoveredRevision = session.runRevision ?? 0;
    return {
      ...session,
      ...existing,
      status:
        currentRevision > discoveredRevision
          ? existing.status
          : session.status,
      ...(existing.runRevision !== undefined || session.runRevision !== undefined
        ? { runRevision: Math.max(currentRevision, discoveredRevision) }
        : {}),
    };
  });
  // Discovery order is activity-ranked and churns between refreshes. Rows already
  // on screen keep their position so the list does not reshuffle under the
  // pointer, while newly discovered sessions arrive at the top.
  const order = new Map(current.map((session, index) => [session.id, index]));
  const seen = merged.filter((session) => order.has(session.id));
  const fresh = merged.filter((session) => !order.has(session.id));
  seen.sort(
    (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
  );
  return [...retained, ...seen, ...fresh];
}
