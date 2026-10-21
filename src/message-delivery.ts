import type {
  MessageInput,
  SessionStatus,
  TranscriptItem,
} from "../shared/agent-contract";
import { copyableMessageText } from "./transcript-utils";
import { isImmediateSdkCommandSubmission, normalizeComposerText } from "./composer-utils";

export const MESSAGE_DELIVERY_IDLE_GRACE_MS = 10_000;

export interface MessageDeliverySessionState {
  status: SessionStatus;
  phase?: string;
  attachment?: "attached" | "attachable" | "terminal-only" | "recovering";
  connection?: "connecting" | "connected" | "disconnected" | "error";
}

export interface DeliveryTranscriptCoverage {
  kind: "latest" | "other";
  complete: boolean;
  requestedAt?: number;
}

export interface MessageDeliveryAttempt {
  id: string;
  sessionId: string;
  input: MessageInput;
  state: "pending" | "failed";
  retrying: boolean;
  submitting: boolean;
}

interface StoredAttempt extends MessageDeliveryAttempt {
  submittedAt: number;
  baselineMatches: number;
  baselineIds: Set<string>;
  baselineUserIds: Set<string>;
  baselineFenceId?: string;
  baselineKnown: boolean;
  idleSince?: number;
  submitting: boolean;
  submissionGeneration: number;
}

interface UserRequest {
  text: string;
  files: string[];
  hasImages: boolean;
}

function basename(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}

function requestText(text: string): string {
  const bare = text.trim().replace(/^\/(?:steer|queue)(?:\s+|$)/iu, "").trim();
  return normalizeComposerText(bare);
}

function userRequest(input: MessageInput): UserRequest {
  return {
    text: requestText(input.text),
    files: input.files.map((file) => basename(file.name)).sort(),
    hasImages: input.images.length > 0,
  };
}

function pathsFromContent(content: string, kind: "files" | "images"): string[] {
  const names: string[] = [];
  for (const block of content.matchAll(new RegExp(`<local-${kind}>([\\s\\S]*?)<\\/local-${kind}>`, "gu"))) {
    for (const line of block[1]!.matchAll(/^\s*-\s+(.+?)\s*$/gmu)) {
      const raw = line[1]!;
      try {
        const path = JSON.parse(raw) as unknown;
        if (typeof path === "string") names.push(basename(path));
      } catch {
        names.push(basename(raw.replace(/^['"]|['"]$/gu, "")));
      }
    }
  }
  if (kind === "files")
    for (const block of content.matchAll(/\[Files:\s*([^\]]*)\]/giu))
      for (const file of block[1]!.split(/,\s*/u)) {
        const name = file.replace(/\s+\(\d+ bytes\)$/u, "").trim();
        if (name) names.push(basename(name));
      }
  return names.sort();
}

function transcriptRequest(
  item: Extract<TranscriptItem, { kind: "message" }>,
): UserRequest {
  const content = copyableMessageText(item.content)
    .replace(/\[Files:\s*[^\]]*\]/giu, "")
    .replace(/\[Images:\s*[^\]]*\]/giu, "");
  const hasImages = pathsFromContent(item.content, "images").length > 0 ||
    /<local-images>/u.test(item.content) || Boolean(item.images?.length);
  return {
    text: normalizeComposerText(content.replace(/^\/(?:steer|queue)(?:\s+|$)/iu, "").trim()),
    files: pathsFromContent(item.content, "files"),
    hasImages,
  };
}

function sameRequest(left: UserRequest, right: UserRequest): boolean {
  if (left.text !== right.text || left.hasImages !== right.hasImages) return false;
  if (left.files.length !== right.files.length ||
    !left.files.every((name, index) => name === right.files[index])) return false;
  // Images without native paths are persisted as embedded image content and may
  // not retain their source filename. Presence is durable; source names are not.
  return true;
}

function durableUserRows(items: readonly TranscriptItem[]): Extract<TranscriptItem, { kind: "message" }>[] {
  return items.filter(
    (item): item is Extract<TranscriptItem, { kind: "message" }> =>
      item.kind === "message" &&
      item.role === "user" &&
      !item.id.startsWith("local-prompt-"),
  );
}

function promptHasPayload(
  input: MessageInput,
  commands: readonly { name: string }[],
): boolean {
  const text = input.text.trim();
  if (input.images.length > 0 || input.files.length > 0) return true;
  if (!text) return false;
  const explicitPrompt = /^\/(?:steer|queue)(?:\s+|$)/iu;
  if (explicitPrompt.test(text)) return Boolean(requestText(text));
  if (!text.startsWith("/")) return true;
  const name = /^\/([^\s]+)/u.exec(text)?.[1]?.toLowerCase();
  if (!name) return false;
  if (name.startsWith("skill:")) return true;
  if (["abort", "compact", "new", "model", "models", "effort", "fast"].includes(name))
    return false;
  return !isImmediateSdkCommandSubmission(text, commands, false);
}

function canStartIdleGrace(state: MessageDeliverySessionState | undefined): boolean {
  return state?.status === "idle" &&
    state.phase !== "compacting" &&
    state.attachment === "attached" &&
    state.connection === "connected";
}

function copyInput(input: MessageInput): MessageInput {
  return {
    text: input.text,
    images: input.images.map((image) => ({ ...image })),
    files: input.files.map((file) => ({ ...file })),
  };
}

export function messageDeliveryRequestText(input: MessageInput): string {
  return requestText(input.text);
}

/** Local optimistic rows keep a request visible, but are never delivery evidence. */
export function deliveryEchoMatches(
  input: MessageInput,
  item: TranscriptItem,
): boolean {
  if (item.kind !== "message" || item.role !== "user" || !item.id.startsWith("local-prompt-"))
    return false;
  const expected = userRequest(input);
  const actual = transcriptRequest(item);
  if (item.id.startsWith("local-prompt-renderer-"))
    return expected.text === actual.text;
  return sameRequest(expected, actual);
}

export function isTrackableMessageInput(
  input: MessageInput,
  commands: readonly { name: string }[] = [],
): boolean {
  return promptHasPayload(input, commands);
}

/**
 * Tracks request attempts independently from optimistic transcript rows. Durable
 * transcript evidence is consumed once, in occurrence order, so one historical
 * or newly-arrived row cannot acknowledge multiple identical submissions.
 */
export class MessageDeliveryTracker {
  private readonly attempts: StoredAttempt[] = [];
  private readonly latestCoverage = new Map<string, {
    readAt: number;
    requestedAt: number;
    complete: boolean;
  }>();
  private readonly sessions = new Map<string, MessageDeliverySessionState>();
  private readonly consumedEvidenceIds = new Map<string, Set<string>>();
  private nextId = 1;

  submit(
    sessionId: string,
    input: MessageInput,
    items: readonly TranscriptItem[],
    now: number,
    session?: MessageDeliverySessionState,
    baselineKnown = true,
  ): string {
    const copiedInput = copyInput(input);
    const request = userRequest(copiedInput);
    if (session) this.observeSession(sessionId, session, now);
    const baselineRows = durableUserRows(items).filter((item) => sameRequest(transcriptRequest(item), request));
    const record: StoredAttempt = {
      id: `message-delivery-${this.nextId++}`,
      sessionId,
      input: copiedInput,
      state: "pending",
      retrying: false,
      submittedAt: now,
      baselineMatches: durableUserRows(items).at(-1) ? 0 : baselineRows.length,
      baselineIds: new Set(baselineRows.map((item) => item.id)),
      baselineUserIds: new Set(durableUserRows(items).map((item) => item.id)),
      baselineFenceId: durableUserRows(items).at(-1)?.id,
      baselineKnown,
      submitting: true,
      submissionGeneration: 1,
      ...(canStartIdleGrace(this.sessions.get(sessionId)) ? { idleSince: now } : {}),
    };
    this.attempts.push(record);
    return record.id;
  }

  observeTranscript(
    sessionId: string,
    items: readonly TranscriptItem[],
    coverage: DeliveryTranscriptCoverage,
    now: number,
  ): void {
    if (coverage.kind === "latest")
      this.latestCoverage.set(sessionId, {
        readAt: now,
        requestedAt: coverage.requestedAt ?? now,
        complete: coverage.complete,
      });
    this.reconcileSnapshot(sessionId, items);
    this.advance(now);
  }

  /** Appended events are positive evidence even when no complete page is loaded. */
  observeUserEvent(sessionId: string, item: TranscriptItem, now: number): void {
    if (item.kind !== "message" || item.role !== "user" || item.id.startsWith("local-prompt-")) return;
    if (!this.attempts.some((attempt) => attempt.sessionId === sessionId)) return;
    const consumed = this.consumedEvidenceIds.get(sessionId) ?? new Set<string>();
    if (consumed.has(item.id)) return;
    const actual = transcriptRequest(item);
    const attempt = this.attempts.find((candidate) =>
      candidate.sessionId === sessionId &&
      (!candidate.baselineKnown || !candidate.baselineUserIds.has(item.id)) &&
      sameRequest(userRequest(candidate.input), actual),
    );
    if (attempt) {
      consumed.add(item.id);
      this.consumedEvidenceIds.set(sessionId, consumed);
      this.removeAttempt(attempt);
    }
    this.advance(now);
  }

  observeSession(
    sessionId: string,
    state: MessageDeliverySessionState | undefined,
    now: number,
  ): void {
    if (state) this.sessions.set(sessionId, state);
    else this.sessions.delete(sessionId);
    for (const attempt of this.attempts) {
      if (attempt.sessionId !== sessionId) continue;
      if (canStartIdleGrace(state)) {
        if (attempt.idleSince === undefined) attempt.idleSince = now;
      } else {
        attempt.idleSince = undefined;
        if (attempt.state === "failed") attempt.state = "pending";
      }
    }
    this.advance(now);
  }

  advance(now: number): void {
    for (const attempt of this.attempts) {
      if (attempt.state !== "pending" || attempt.retrying) continue;
      const session = this.sessions.get(attempt.sessionId);
      if (!canStartIdleGrace(session)) {
        attempt.idleSince = undefined;
        continue;
      }
      if (attempt.idleSince === undefined) attempt.idleSince = now;
      const coverage = this.latestCoverage.get(attempt.sessionId);
      if (
        coverage?.complete &&
        coverage.requestedAt >= attempt.idleSince &&
        coverage.readAt >= attempt.idleSince &&
        now - attempt.idleSince >= MESSAGE_DELIVERY_IDLE_GRACE_MS
      ) {
        attempt.state = "failed";
        // A stuck transport response does not outweigh a complete latest read
        // and a full idle grace period. Recovery remains manual, never automatic.
        attempt.retrying = false;
        attempt.submitting = false;
        attempt.submissionGeneration += 1;
      }
    }
  }

  beginRetry(id: string): { sessionId: string; input: MessageInput } | undefined {
    const attempt = this.attempts.find((candidate) => candidate.id === id);
    if (!attempt || attempt.state !== "failed" || attempt.retrying) return undefined;
    attempt.state = "pending";
    attempt.retrying = true;
    attempt.submitting = true;
    attempt.submissionGeneration += 1;
    attempt.idleSince = undefined;
    return { sessionId: attempt.sessionId, input: copyInput(attempt.input) };
  }

  submitRetry(
    id: string,
    sessionId: string,
    items: readonly TranscriptItem[],
    now: number,
    session?: MessageDeliverySessionState,
    baselineKnown = true,
  ): boolean {
    const attempt = this.attempts.find((candidate) => candidate.id === id);
    if (!attempt || !attempt.retrying) return false;
    attempt.sessionId = sessionId;
    attempt.submittedAt = now;
    const baselineRows = durableUserRows(items).filter((item) => sameRequest(transcriptRequest(item), userRequest(attempt.input)));
    attempt.baselineMatches = durableUserRows(items).at(-1) ? 0 : baselineRows.length;
    attempt.baselineIds = new Set(baselineRows.map((item) => item.id));
    attempt.baselineUserIds = new Set(durableUserRows(items).map((item) => item.id));
    attempt.baselineFenceId = durableUserRows(items).at(-1)?.id;
    attempt.baselineKnown = baselineKnown;
    attempt.submitting = true;
    if (session) this.observeSession(sessionId, session, now);
    return true;
  }

  submissionGeneration(id: string): number | undefined {
    return this.attempts.find((candidate) => candidate.id === id)?.submissionGeneration;
  }

  finishRetry(id: string, now: number, generation: number): void {
    const attempt = this.attempts.find((candidate) => candidate.id === id);
    if (!attempt || attempt.submissionGeneration !== generation) return;
    attempt.retrying = false;
    attempt.submitting = false;
    attempt.idleSince = canStartIdleGrace(this.sessions.get(attempt.sessionId)) ? now : undefined;
    this.advance(now);
  }

  acceptSubmission(id: string, now: number, generation: number): void {
    const attempt = this.attempts.find((candidate) => candidate.id === id);
    if (!attempt || attempt.submissionGeneration !== generation) return;
    attempt.submitting = false;
    attempt.idleSince = canStartIdleGrace(this.sessions.get(attempt.sessionId)) ? now : undefined;
    this.advance(now);
  }

  rejectSubmission(id: string, now: number, generation: number, preserve: boolean): void {
    const attempt = this.attempts.find((candidate) => candidate.id === id);
    if (!attempt || attempt.submissionGeneration !== generation) return;
    if (!preserve) {
      this.removeAttempt(attempt);
      return;
    }
    attempt.retrying = false;
    attempt.submitting = false;
    attempt.state = "failed";
    attempt.idleSince = canStartIdleGrace(this.sessions.get(attempt.sessionId)) ? now : undefined;
  }

  snapshot(sessionId: string): MessageDeliveryAttempt[] {
    return this.attempts
      .filter((attempt) => attempt.sessionId === sessionId)
      .map(({ id, input, state, retrying, submitting, sessionId: owner }) => ({
        id,
        sessionId: owner,
        input: copyInput(input),
        state,
        retrying,
        submitting,
      }));
  }

  sessionIds(): string[] {
    return [...new Set(this.attempts.map((attempt) => attempt.sessionId))];
  }

  needsLatestRead(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!canStartIdleGrace(session)) return false;
    const coverage = this.latestCoverage.get(sessionId);
    return this.attempts.some((attempt) => {
      if (attempt.sessionId !== sessionId || attempt.state !== "pending" || attempt.retrying)
        return false;
      const boundary = Math.max(attempt.submittedAt, attempt.idleSince ?? 0);
      return !coverage || !coverage.complete ||
        coverage.requestedAt < boundary || coverage.readAt < boundary;
    });
  }

  nextDeadline(): number | undefined {
    let deadline: number | undefined;
    for (const attempt of this.attempts) {
      if (attempt.state !== "pending" || attempt.retrying) continue;
      if (!canStartIdleGrace(this.sessions.get(attempt.sessionId)) || attempt.idleSince === undefined) continue;
      const coverage = this.latestCoverage.get(attempt.sessionId);
      if (
        !coverage?.complete ||
        coverage.requestedAt < attempt.idleSince ||
        coverage.readAt < attempt.idleSince
      ) continue;
      const due = attempt.idleSince + MESSAGE_DELIVERY_IDLE_GRACE_MS;
      if (deadline === undefined || due < deadline) deadline = due;
    }
    return deadline;
  }

  private reconcileSnapshot(sessionId: string, items: readonly TranscriptItem[]): void {
    const rows = durableUserRows(items);
    const consumedIds = this.consumedEvidenceIds.get(sessionId) ?? new Set<string>();
    for (const attempt of [...this.attempts]) {
      if (attempt.sessionId !== sessionId || !attempt.baselineKnown) continue;
      const expected = userRequest(attempt.input);
      let occurrence = 0;
      let match: Extract<TranscriptItem, { kind: "message" }> | undefined;
      const fenceIndex = attempt.baselineFenceId
        ? rows.findIndex((row) => row.id === attempt.baselineFenceId)
        : -1;
      if (attempt.baselineFenceId && fenceIndex < 0) continue;
      for (let index = fenceIndex + 1; index < rows.length; index += 1) {
        const row = rows[index]!;
        if (!sameRequest(transcriptRequest(row), expected)) continue;
        if (
          occurrence >= attempt.baselineMatches &&
          !attempt.baselineIds.has(row.id) &&
          !attempt.baselineUserIds.has(row.id) &&
          !consumedIds.has(row.id)
        ) {
          match = row;
          break;
        }
        occurrence += 1;
      }
      if (!match) continue;
      consumedIds.add(match.id);
      this.consumedEvidenceIds.set(sessionId, consumedIds);
      this.removeAttempt(attempt);
    }
  }

  private removeAttempt(attempt: StoredAttempt): void {
    const index = this.attempts.indexOf(attempt);
    if (index >= 0) this.attempts.splice(index, 1);
  }
}
