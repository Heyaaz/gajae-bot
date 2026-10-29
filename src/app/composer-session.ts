import type { FileAttachment } from "../../shared/agent-contract";
import type { ImageAttachment, MessageInput } from "../backend/types";
import {
  appendPendingRequest,
  composerQueuePreview,
  liveTurnSubmissionMode,
  releaseRequests,
} from "../composer-utils";
import type { LiveTurnSubmissionMode, PendingRequest } from "../composer-utils";

export type ComposerDraft = {
  value: string;
  images: ImageAttachment[];
  files: FileAttachment[];
};

export type ComposerSnapshot = ComposerDraft & { pendingQueue: PendingRequest[] };

// Screen navigation can unmount the composer without ending the session. Keep
// its local-only work outside the component lifetime, keyed by session identity.
export const composerSnapshots = new Map<string, ComposerSnapshot>();

/**
 * Text that still has to reach whichever composer is active for its session: a
 * rejected send, whose outcome is unknown and says so, or a prefill the user has
 * not sent yet, which arrives without a notice.
 */
export type ComposerDraftRecovery = {
  revision: number;
  input: MessageInput;
  origin: "rejected-send" | "prefill";
};

let recoveryRevision = 0;
const draftRecoveries = new Map<string, ComposerDraftRecovery[]>();
const draftRecoveryListeners = new Map<string, Set<() => void>>();

/**
 * Queue a failed submission for its session rather than the component instance
 * that sent it. A remounted composer has new refs and a new draft; only session
 * identity survives that replacement.
 */
export function publishComposerDraftRecovery(
  sessionId: string,
  input: MessageInput,
  origin: ComposerDraftRecovery["origin"] = "rejected-send",
): void {
  const entries = draftRecoveries.get(sessionId) ?? [];
  entries.push({ revision: ++recoveryRevision, input, origin });
  draftRecoveries.set(sessionId, entries.slice(-50));
  for (const listener of draftRecoveryListeners.get(sessionId) ?? []) listener();
}

/** Put text and images into a session's draft without sending them, mounted composer or not. */
export function prefillComposerDraft(
  sessionId: string,
  text: string,
  images: ImageAttachment[] = [],
): void {
  publishComposerDraftRecovery(sessionId, { text, images, files: [] }, "prefill");
}

export function composerDraftRecoveries(
  sessionId: string,
): readonly ComposerDraftRecovery[] {
  return draftRecoveries.get(sessionId) ?? [];
}

export function acknowledgeComposerDraftRecoveries(
  sessionId: string,
  throughRevision: number,
): void {
  const remaining = (draftRecoveries.get(sessionId) ?? []).filter(
    (entry) => entry.revision > throughRevision,
  );
  if (remaining.length > 0) draftRecoveries.set(sessionId, remaining);
  else draftRecoveries.delete(sessionId);
}

export function subscribeComposerDraftRecovery(
  sessionId: string,
  listener: () => void,
): () => void {
  const listeners = draftRecoveryListeners.get(sessionId) ?? new Set();
  listeners.add(listener);
  draftRecoveryListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) draftRecoveryListeners.delete(sessionId);
  };
}

/** Merge rejected inputs over a newer draft without replacing what the user typed. */
export function mergeRecoveredDraft(
  current: ComposerDraft,
  recovered: readonly MessageInput[],
): ComposerDraft {
  let merged = current;
  for (const input of recovered)
    merged = {
      value: [input.text, merged.value].filter(Boolean).join("\n"),
      images: [...input.images, ...merged.images],
      files: [...input.files, ...merged.files],
    };
  return merged;
}

export function saveComposerSnapshot(
  snapshots: Map<string, ComposerSnapshot>,
  sessionId: string,
  snapshot: ComposerSnapshot,
): void {
  snapshots.set(sessionId, snapshot);
}

// A release belongs to the session, not to the composer instance that started it.
// The shell and a mounted composer both observe the end of a turn, and a request
// may only be handed over once.
export const releasingQueues = new Set<string>();
const queueListeners = new Map<string, Set<() => void>>();
const queueReleaseRetryListeners = new Set<(sessionId: string) => void>();

/** Watch for a release lock that ended with work still queued. */
export function subscribeComposerReleaseRetry(
  listener: (sessionId: string) => void,
): () => void {
  queueReleaseRetryListeners.add(listener);
  return () => queueReleaseRetryListeners.delete(listener);
}

/**
 * Hand still-releasable work back after the owning instance gives up its lock.
 *
 * The shell observed the idle transition while this lock was held and could not
 * start its own release. Without this notice the retired instance's finally block
 * only freed the lock, leaving an idle session with a queued request forever.
 */
export function requestQueueReleaseRetry(
  sessionId: string,
  pending: readonly PendingRequest[],
): void {
  if (pending.length === 0 || pending[0]?.blocked) return;
  for (const listener of queueReleaseRetryListeners) listener(sessionId);
}

/** Watch a session's held queue even when this composer is not the one sending. */
export function subscribeComposerQueue(
  sessionId: string,
  listener: () => void,
): () => void {
  const listeners = queueListeners.get(sessionId) ?? new Set();
  listeners.add(listener);
  queueListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) queueListeners.delete(sessionId);
  };
}

/** The queue the shell may release while the composer is showing another screen. */
export function composerQueue(sessionId: string): PendingRequest[] {
  return composerSnapshots.get(sessionId)?.pendingQueue ?? [];
}

export function saveComposerQueue(
  sessionId: string,
  pending: PendingRequest[],
): void {
  const snapshot = composerSnapshots.get(sessionId);
  saveComposerSnapshot(composerSnapshots, sessionId, {
    ...(snapshot ?? { value: "", images: [], files: [] }),
    pendingQueue: pending,
  });
  for (const listener of queueListeners.get(sessionId) ?? []) listener();
}

/**
 * Park the queue of the session being left and load the next session's queue.
 *
 * The module snapshot is authoritative for a session this composer is not
 * showing. Keeping a component-local copy here is what let a queue released by
 * the shell reappear when the user navigated back.
 */
export function parkComposerSession(
  previous: string,
  activeQueue: PendingRequest[],
  next: string,
): PendingRequest[] {
  saveComposerQueue(previous, activeQueue);
  return composerQueue(next);
}

/**
 * Hand over a session's held requests without a mounted composer.
 *
 * The shell calls this when a run ends while another screen is open. Ownership is
 * keyed by session so this loop and a mounted composer's own release can never
 * both send the same request.
 */
export async function releaseQueuedSession(
  sessionId: string,
  send: (request: PendingRequest) => Promise<unknown>,
  canSend: () => boolean = () => true,
): Promise<void> {
  if (releasingQueues.has(sessionId) || composerQueue(sessionId).length === 0)
    return;
  releasingQueues.add(sessionId);
  try {
    await releaseRequests({
      canSend,
      read: () => composerQueue(sessionId),
      write: (pending) => saveComposerQueue(sessionId, pending),
      send: (request) => send(request),
    });
  } finally {
    releasingQueues.delete(sessionId);
  }
}

/** The held row a submission becomes while a turn is live. */
export function heldComposerRequest(
  content: string,
  files: FileAttachment[],
  images: ImageAttachment[],
  runningSubmission: LiveTurnSubmissionMode,
): PendingRequest {
  const preview = composerQueuePreview(content, files, images);
  const mode = liveTurnSubmissionMode(content, runningSubmission, false) === "steer"
    ? "steer" : "followUp";
  return {
    id: `local-${crypto.randomUUID()}`,
    text: preview.text,
    mode,
    label: mode === "steer" ? "Steer" : "Queued",
    images,
    files,
  };
}

/**
 * Submit for a session exactly as Enter in its composer would, whether or not
 * that composer is mounted. A live turn, or work already held, makes it a held
 * row in the session's queue; otherwise it is sent, and a rejected send returns
 * to the session's draft with the same notice Enter gives.
 */
export function submitComposerInput(
  sessionId: string,
  input: MessageInput,
  options: {
    running: boolean;
    runningSubmission: LiveTurnSubmissionMode;
    send: (input: MessageInput) => Promise<unknown>;
  },
): void {
  const pending = composerQueue(sessionId);
  if (options.running || pending.length > 0) {
    saveComposerQueue(
      sessionId,
      appendPendingRequest(
        pending,
        heldComposerRequest(input.text, input.files, input.images, options.runningSubmission),
      ),
    );
    return;
  }
  void options.send(input).catch(() => publishComposerDraftRecovery(sessionId, input));
}

/** Whether any release for this session is already handing requests over. */
export function queueReleaseInFlight(sessionId: string): boolean {
  return releasingQueues.has(sessionId);
}

export function mergePreparedAttachments<T>(
  current: readonly T[],
  prepared: readonly T[],
  limit: number,
): T[] {
  return [...current, ...prepared].slice(0, limit);
}

export function storePreparedAttachments(
  drafts: Map<string, { value: string; images: ImageAttachment[]; files: FileAttachment[] }>,
  owner: string,
  kind: "images" | "files",
  prepared: ImageAttachment[] | FileAttachment[],
): void {
  const draft = drafts.get(owner) ?? { value: "", images: [], files: [] };
  if (kind === "images")
    draft.images = mergePreparedAttachments(draft.images, prepared as ImageAttachment[], 6);
  else draft.files = mergePreparedAttachments(draft.files, prepared as FileAttachment[], 5);
  drafts.set(owner, draft);
}

export async function cancelBeforeQueueDiscard(
  cancel: () => Promise<void>,
  discard: () => void,
): Promise<void> {
  await cancel();
  discard();
}

export function restoreRejectedDraft(
  currentOwner: string,
  drafts: Map<string, { value: string; images: ImageAttachment[]; files: FileAttachment[] }>,
  owner: string,
  input: MessageInput,
): { value: string; images: ImageAttachment[]; files: FileAttachment[] } | null {
  const failed = { value: input.text, images: input.images, files: input.files };
  if (currentOwner === owner) return failed;
  // The user moved on and may have written a new draft in that session meanwhile.
  // Replacing it with the rejected input lost everything typed after the send.
  const parked = drafts.get(owner);
  drafts.set(
    owner,
    parked
      ? {
          value: [failed.value, parked.value].filter(Boolean).join("\n"),
          images: [...failed.images, ...parked.images],
          files: [...failed.files, ...parked.files],
        }
      : failed,
  );
  return null;
}

/**
 * Whether a release loop may hand over another request.
 *
 * Ownership alone is not enough: the composer that started the loop can unmount
 * while its awaited send is still in flight, and its refs still name the session.
 * A remounted instance restores the same queue from the snapshot, so without the
 * mount check both loops would send the next request twice.
 */
export function canReleaseQueue(
  mounted: boolean,
  draftOwner: string,
  owner: string,
): boolean {
  return mounted && draftOwner === owner;
}

