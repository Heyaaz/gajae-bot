import type { FileAttachment, MessageDelivery } from "../../shared/agent-contract";
import type { AgentCommand, AgentConfigOption, ImageAttachment, MessageInput } from "../backend/types";
import {
  appendPendingRequest,
  composerQueuePreview,
  consumeQueuePullKey,
  droppedImageAttachments,
  IME_FOLLOWUP_WINDOW_MS,
  imeCommitSubmits,
  isImmediateSdkCommandSubmission,
  isDuplicateSubmission,
  parkDraft,
  pullQueuedRequest,
  releaseRequests,
  resolveModelPreset,
  restoreDraft,
  restorePulledDraft,
  withoutReleasedRequest,
} from "../composer-utils";
import type { PendingRequest, QueuePullTarget } from "../composer-utils";
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleStop,
  Command,
  FolderGit2,
  FolderOpen,
  Paperclip,
  Sparkles,
  Zap,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { configOptionGroups, directoryName, httpUrls, humanErrorMessage } from "./format";
import { LinkPreviewCard } from "./primitives";

const FAST_SERVICE_TIERS = new Set([
  "priority",
  "openai-only",
  "claude-only",
]);

type ComposerDraft = {
  value: string;
  images: ImageAttachment[];
  files: FileAttachment[];
};

export type ComposerSnapshot = ComposerDraft & { pendingQueue: PendingRequest[] };

// Screen navigation can unmount the composer without ending the session. Keep
// its local-only work outside the component lifetime, keyed by session identity.
const composerSnapshots = new Map<string, ComposerSnapshot>();

/** A rejected send that still has to reach whichever composer is active for its session. */
export type ComposerDraftRecovery = {
  revision: number;
  input: MessageInput;
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
): void {
  const entries = draftRecoveries.get(sessionId) ?? [];
  entries.push({ revision: ++recoveryRevision, input });
  draftRecoveries.set(sessionId, entries.slice(-50));
  for (const listener of draftRecoveryListeners.get(sessionId) ?? []) listener();
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
const releasingQueues = new Set<string>();
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
): Promise<void> {
  if (releasingQueues.has(sessionId) || composerQueue(sessionId).length === 0)
    return;
  releasingQueues.add(sessionId);
  try {
    await releaseRequests({
      canSend: () => true,
      read: () => composerQueue(sessionId),
      write: (pending) => saveComposerQueue(sessionId, pending),
      send: (request) => send(request),
    });
  } finally {
    releasingQueues.delete(sessionId);
  }
}

/** Whether any release for this session is already handing requests over. */
export function queueReleaseInFlight(sessionId: string): boolean {
  return releasingQueues.has(sessionId);
}

/**
 * Apply a Fast tier change through the runtime's own service-tier control.
 *
 * The command is sent with no attachments on purpose: the runtime only treats a
 * slash command as a control when the message carries none, and only a control
 * applies to the session immediately -- with an attachment the same text would be
 * delivered as prompt work into the open turn.
 *
 * Nothing here predicts the outcome. The composer's indicator follows the
 * serviceTier the session reports back, so a refused request leaves the buttons on
 * the tier that is actually in force instead of a state this call invented. That
 * refusal is reported and consumed rather than re-thrown: the send came from a
 * button with no awaiting caller, so an escaping rejection would land in the
 * renderer's unhandled queue.
 */
export async function requestFastTier(options: {
  fast: boolean;
  send: (input: MessageInput) => Promise<MessageDelivery | undefined>;
  report: (message: string) => void;
}): Promise<void> {
  try {
    await options.send({
      text: options.fast ? "/fast on" : "/fast off",
      images: [],
      files: [],
    });
  } catch (error) {
    options.report(error instanceof Error ? error.message : String(error));
  }
}

/** A Fast request in flight, owned by the session that asked for it. */
export interface FastTierRequest {
  sessionId: string;
}

/**
 * Whether this session has a Fast request of its own on the wire.
 *
 * Ownership is compared instead of holding one boolean, because the composer is a
 * single mounted component for every session: a request sent from one row can
 * still be in flight long after the user moved on, and a plain flag left the next
 * row's buttons disabled behind work that no longer concerned it.
 */
export function fastTierBusy(
  request: FastTierRequest | null,
  sessionId: string,
): boolean {
  return request?.sessionId === sessionId;
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

/** Whether this session's runtime advertises the Fast service-tier control. */
export function advertisesFast(
  commands: readonly { name: string }[],
): boolean {
  return commands.some((command) => command.name === "fast");
}

export interface FastTierControlsProps {
  commands: readonly { name: string }[];
  /** Whether the session reports a priority tier right now, never a local guess. */
  fastMode: boolean;
  /** A Fast request for this session is still awaiting the runtime. */
  busy: boolean;
  readOnly: boolean;
  onSelect: (fast: boolean) => void;
}

/**
 * The Fast pair in the model popover header.
 *
 * Two named buttons rather than one toggle: the tier belongs to the runtime, so
 * each press says which state is being asked for and `aria-pressed` marks the one
 * in force. The runtime only offers the control when it advertises `/fast`, so a
 * backend without a service tier shows no buttons at all. Pressing one leaves the
 * menu open -- the model list is the same menu, and closing it would hide the
 * profiles the user came for.
 */
export function FastTierControls({
  commands,
  fastMode,
  busy,
  readOnly,
  onSelect,
}: FastTierControlsProps) {
  if (!advertisesFast(commands)) return null;
  const disabled = readOnly || busy;
  return (
    <span
      className="config-option-menu-fast"
      role="group"
      aria-label="Fast 모드"
    >
      <button
        type="button"
        aria-pressed={fastMode}
        disabled={disabled}
        title="Fast 모드 켜기 (/fast on)"
        onClick={() => onSelect(true)}
      >
        Fast on
      </button>
      <button
        type="button"
        aria-pressed={!fastMode}
        disabled={disabled}
        title="Fast 모드 끄기 (/fast off)"
        onClick={() => onSelect(false)}
      >
        Fast off
      </button>
    </span>
  );
}

/**
 * The draft a selected palette command leaves in the composer.
 *
 * The trailing space is not cosmetic. The palette matches the bare `/name` query,
 * so leaving the textarea on exactly the value that was selected kept the match
 * alive and the next Enter re-selected the command instead of submitting it. Only
 * commands that still need input reach this line -- a hint-less command without the
 * `skill:` prefix was executed and returned above, and `skill:*` is agent work that
 * has to stay a draft -- so the space is unconditional.
 */
export function selectedCommandDraft(name: string): string {
  return `/${name} `;
}

/**
 * The composer state one Enter keydown is decided against, and nothing else the
 * textarea's keydown handler deals with.
 *
 * The Enter paths are split out of that handler so the contract -- including the
 * Shift+Enter newline, which has to leave the keydown to the textarea -- can be
 * driven directly in tests the way the sidebar's Escape consumer is.
 */
export interface ComposerEnterEvent {
  key: string;
  /** Shift+Enter is always a newline, never a submit. */
  shiftKey: boolean;
  /** Any of the signals the Korean IME raises while its last syllable is open. */
  composing: boolean;
  /** When the last composition commit landed, in `performance.now()` time. */
  compositionEndedAt: number;
  /** `performance.now()` for this keydown. */
  now: number;
  /** The textarea holds nothing but whitespace. */
  draftEmpty: boolean;
  /** The slash-command palette is open and owns a settled Enter. */
  paletteOpen: boolean;
}

export interface ComposerEnterEffects {
  preventDefault: () => void;
  /** Send the draft, or hold it behind the queue -- everything Enter means. */
  submit: () => void;
  /** Hold this Enter until the composition it landed in commits. */
  arm: (at: number) => void;
  /** Forget an armed Enter so a later commit cannot submit on its behalf. */
  disarm: () => void;
  /** Submit once the frame that ends the current composition has run. */
  defer: () => void;
}

/**
 * Apply one Enter keydown to the composer, returning whether it was consumed.
 *
 * Shift+Enter is the one path that is never consumed: it leaves the keydown
 * un-prevented so the textarea inserts the newline and the autosize picks up the
 * taller draft. That has to hold mid-composition too -- the IME delivers a plain
 * Enter while the final syllable is still open, and treating that same signal as a
 * submit on Shift+Enter queued the text the user was only making a line break in.
 * An Enter armed by an earlier keypress is dropped here as well: the commit that
 * follows this keystroke is the IME closing *this* line, not finishing that submit.
 *
 * A plain Enter keeps its two IME paths (arm now, submit from the commit; submit
 * from the follow-up keydown right after a commit) and its two settled meanings
 * (the palette's selection, or send/hold depending on the turn).
 */
export function handleComposerEnter(
  event: ComposerEnterEvent,
  effects: ComposerEnterEffects,
): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey) {
    effects.disarm();
    return false;
  }
  // macOS Korean IME emits Enter while the final syllable is still composing.
  // Treating that keydown as submit sends the full sentence and then the last
  // syllable again as a second steer (for example "steer 테스트" + "트"), so the
  // submission waits for the IME to commit. It is armed here and fired from
  // compositionend, which is the first moment the final text is readable.
  if (event.composing) {
    effects.preventDefault();
    // An empty draft has nothing left to compose, so this is a real empty
    // submit -- the gesture that interrupts the run and releases the queue.
    if (event.draftEmpty) {
      effects.disarm();
      effects.submit();
      return true;
    }
    effects.arm(event.now);
    return true;
  }
  // One physical Enter can reach the handler twice around a commit: once while
  // the composition still owns it (armed above) and once after the commit has
  // landed. Both are the same submission, so the second only defers to the frame
  // the commit scheduled.
  if (event.now - event.compositionEndedAt < IME_FOLLOWUP_WINDOW_MS) {
    effects.preventDefault();
    if (!event.draftEmpty) effects.defer();
    return true;
  }
  // The palette selects its highlighted command rather than sending the query.
  if (event.paletteOpen) return false;
  effects.preventDefault();
  effects.submit();
  return true;
}

export interface QueueChipProps {
  entry: PendingRequest;
  onPull: () => void;
  onDiscard: () => void;
}

/**
 * One held request and its two gestures.
 *
 * The chip body pulls the request back into the draft, where the exact text can be
 * edited or sent on its own; the × beside it discards that one entry. `type` is
 * explicit on both: the composer is a form, so a bare button here would submit the
 * draft the user is trying to take a request out of.
 */
export function QueueChip({ entry, onPull, onDiscard }: QueueChipProps) {
  return (
    <span className={`composer-queue-item composer-queue-item--${entry.mode}${entry.blocked ? " composer-queue-item--blocked" : ""}`}>
      <button type="button" className="composer-queue-pull" onClick={onPull}
        title={entry.blocked ? "이미 처리됐을 수 있습니다. 대화 기록을 확인한 뒤 입력창으로 꺼내세요." : undefined}>
        <em>{entry.blocked ? "확인 필요" : entry.mode === "steer" ? "즉시" : "대기"}</em>
        <span className="composer-queue-text">{entry.text}</span>
      </button>
      <button
        type="button"
        className="composer-queue-discard"
        aria-label="대기 항목 버리기"
        onClick={onDiscard}
      >
        <X size={10} />
      </button>
    </span>
  );
}

export interface ComposerProps {
  sessionId: string;
  running: boolean;
  sessionTitle: string;
  workspace: string;
  workspaces: string[];
  commands: AgentCommand[];
  configOptions: AgentConfigOption[];
  modelDisplay?: string;
  thinking?: string;
  usagePercent?: number;
  serviceTier?: string;
  onSend: (input: MessageInput) => Promise<MessageDelivery | undefined>;
  onCancel: () => Promise<void>;
  onFlushQueued: () => Promise<void>;
  onCompact: () => void;
  onNewSession: () => void;
  onWorkspaceChange: (workspace: string) => void;
  onConfigChange: (configId: string, value: string) => void;
  onCycleThinking: () => void;
  /** Set on a view-only remote device: the host would refuse every control. */
  readOnly?: boolean;
}

export function Composer({
  sessionId,
  running,
  sessionTitle,
  workspace,
  workspaces,
  commands,
  configOptions,
  modelDisplay,
  thinking,
  usagePercent,
  serviceTier,
  onSend,
  onCancel,
  onFlushQueued,
  onCompact,
  onNewSession,
  onWorkspaceChange,
  onConfigChange,
  onCycleThinking,
  readOnly = false,
}: ComposerProps) {
  const [value, setValue] = useState(() => composerSnapshots.get(sessionId)?.value ?? "");
  const [images, setImages] = useState(() => composerSnapshots.get(sessionId)?.images ?? []);
  const [files, setFiles] = useState(() => composerSnapshots.get(sessionId)?.files ?? []);
  const [attachmentError, setAttachmentError] = useState("");
  const [choosingImages, setChoosingImages] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fastMode = FAST_SERVICE_TIERS.has(serviceTier ?? "");
  // The Fast request this component sent, if it is still on the wire. It is stored
  // with the session it was sent from so an unfinished request from another row can
  // never hold this row's buttons disabled.
  const [fastRequest, setFastRequest] = useState<FastTierRequest | null>(null);
  const fastRequestRef = useRef<FastTierRequest | null>(null);
  const fastBusy = fastTierBusy(fastRequest, sessionId);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [configMenu, setConfigMenu] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  // The composer is the single owner of pending work. GJC is only told about a
  // request when it is actually released, so there is no remote queue to
  // reconcile against and nothing can retire a chip behind the user's back.
  const [pendingQueue, setPendingQueue] = useState(
    () => composerSnapshots.get(sessionId)?.pendingQueue ?? [],
  );
  const [historyCursor, setHistoryCursor] = useState(-1);
  // A draft belongs to the session it was typed in. The composer is one mounted
  // component for every session, so unsent text has to be parked per session or
  // switching rows would carry it along and let it be sent to the wrong agent.
  const draftsRef = useRef(new Map<string, ComposerDraft>(
    [...composerSnapshots].map(([id, snapshot]) => [id, {
      value: snapshot.value,
      images: snapshot.images,
      files: snapshot.files,
    }]),
  ));
  const draftSessionRef = useRef(sessionId);
  const renderedSessionRef = useRef(sessionId);
  renderedSessionRef.current = sessionId;
  const pendingPreparedRef = useRef(
    new Map<string, { images: ImageAttachment[]; files: FileAttachment[] }>(),
  );
  const mountedRef = useRef(false);
  // Anything the user could submit right now. This decides which single action the
  // submit slot exposes, so send and stop can never render together.
  const hasDraft =
    value.trim().length > 0 || images.length > 0 || files.length > 0;
  const composerRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandPaletteRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const submitAfterCompositionRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const compositionSubmitScheduledRef = useRef(false);
  // When the Enter that is waiting for an IME commit was pressed. A commit that
  // arrives later than this belongs to text typed after that Enter, so it must
  // not inherit the submission.
  const enterArmedAtRef = useRef(0);
  // The Korean IME delivers one Enter through several handlers, each scheduling its
  // own rAF, so no ordering of guard flags closes every window -- two attempts to
  // tune them both still double-submitted. Identify the submission by its draft
  // instead: the same text submitted inside one input frame is the duplicate.
  const lastSubmissionRef = useRef({ text: "", at: 0 });
  // The release loop reads the queue between awaits, so it needs the live value
  // rather than the render-time closure.
  const pendingQueueRef = useRef<PendingRequest[]>([]);
  pendingQueueRef.current = pendingQueue;
  // The session-switch effect parks whatever is in the composer, and it must read
  // the draft as it stands at the switch rather than the value its own closure was
  // created with.
  const valueRef = useRef(value);
  valueRef.current = value;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const filesRef = useRef(files);
  filesRef.current = files;
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptHistoryRef = useRef(new Map<string, string[]>());
  const historyDraftRef = useRef("");
  const settingsBridge = window.agentControlDesktop?.settings;
  const slashBody =
    value.startsWith("/") && !value.includes("\n") ? value.slice(1) : null;
  const commandQuery =
    slashBody !== null && !/\s/u.test(slashBody)
      ? slashBody.toLowerCase()
      : null;
  const matchingCommands =
    commandQuery === null
      ? []
      : commands.filter((command) =>
          command.name.toLowerCase().includes(commandQuery),
        );
  const modelOption = configOptions.find(
    (option) =>
      option.type === "select" &&
      (option.category === "model" || option.id === "model"),
  );
  const thinkingOption = configOptions.find(
    (option) =>
      option.type === "select" &&
      (option.category === "thought_level" || option.id === "thinking"),
  );
  const currentEffort = String(
    thinking ?? thinkingOption?.currentValue ?? "off",
  );
  const draftUrl = httpUrls(value, 1)[0];
  const effortValueRef = useRef(currentEffort);
  effortValueRef.current = currentEffort;

  function discardQueueAfterCancel(owner: string): void {
    void cancelBeforeQueueDiscard(onCancel, () => {
      if (draftSessionRef.current !== owner) {
        saveComposerQueue(owner, []);
        return;
      }
      pendingQueueRef.current = [];
      saveComposerQueue(owner, []);
      setPendingQueue([]);
      saveComposerSnapshot(composerSnapshots, owner, {
        value: valueRef.current,
        images: imagesRef.current,
        files: filesRef.current,
        pendingQueue: [],
      });
    }).catch(() => undefined);
  }

  function restoreRejectedSubmission(
    owner: string,
    input: MessageInput,
  ): void {
    // Session identity outlives this instance. The recovery queue is read by
    // whichever composer is active now, or by the next one to mount.
    publishComposerDraftRecovery(owner, input);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const discardPrepared = useCallback(
    (attachments: Array<{ token?: string }>): void => {
      const tokens = attachments.flatMap((attachment) =>
        attachment.token ? [attachment.token] : [],
      );
      if (tokens.length === 0 || !settingsBridge) return;
      void settingsBridge.discardAttachments(tokens).catch((error) =>
        setAttachmentError(error instanceof Error ? error.message : String(error)),
      );
    },
    [settingsBridge],
  );

  const commitPrepared = useCallback(
    (owner: string, kind: "images" | "files", prepared: ImageAttachment[] | FileAttachment[]): void => {
      if (owner === renderedSessionRef.current && owner === draftSessionRef.current) {
        if (kind === "images") {
          const next = mergePreparedAttachments(imagesRef.current, prepared as ImageAttachment[], 6);
          imagesRef.current = next;
          setImages(next);
        } else {
          const next = mergePreparedAttachments(filesRef.current, prepared as FileAttachment[], 5);
          filesRef.current = next;
          setFiles(next);
        }
        return;
      }
      if (owner === draftSessionRef.current) {
        const pending = pendingPreparedRef.current.get(owner) ?? { images: [], files: [] };
        if (kind === "images") pending.images.push(...prepared as ImageAttachment[]);
        else pending.files.push(...prepared as FileAttachment[]);
        pendingPreparedRef.current.set(owner, pending);
        return;
      }
      storePreparedAttachments(draftsRef.current, owner, kind, prepared);
    },
    [],
  );

  const addDroppedImages = useCallback(
    async (files: FileList | readonly File[]): Promise<void> => {
      const owner = sessionId;
      setAttachmentError("");
      try {
        if (imagesRef.current.length + files.length > 6)
          throw new Error("이미지는 메시지당 최대 6장까지 첨부할 수 있습니다");
        const all = Array.from(files);
        // Only a file selected or dragged from the OS has a main-authorizable
        // native identity. Browser-originated images stay inline; an actual native
        // validation failure must surface rather than silently bypassing the main
        // process capability boundary.
        if (!settingsBridge) {
          const inline = await droppedImageAttachments(all, imagesRef.current.length);
          commitPrepared(owner, "images", inline);
          return;
        }
        const native = all.filter((file) => settingsBridge.isNativeFile(file));
        const pathless = all.filter((file) => !settingsBridge.isNativeFile(file));
        const attachments = native.length
          ? await settingsBridge.prepareImages(native)
          : [];
        const inline = pathless.length
          ? await droppedImageAttachments(
              pathless,
              imagesRef.current.length + attachments.length,
            )
          : [];
        commitPrepared(owner, "images", [...attachments, ...inline]);
      } catch (error) {
        setAttachmentError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [commitPrepared, sessionId, settingsBridge],
  );

  const addDroppedAttachments = useCallback(
    async (dropped: FileList | readonly File[]): Promise<void> => {
      const owner = sessionId;
      const all = Array.from(dropped);
      const imageFiles = all.filter((file) => file.type.startsWith("image/"));
      const textFiles = all.filter((file) => !file.type.startsWith("image/"));
      setAttachmentError("");
      try {
        if (imageFiles.length > 0) await addDroppedImages(imageFiles);
        if (textFiles.length > 0) {
          if (!settingsBridge)
            throw new Error(
              "원격 연결에서는 파일 첨부를 지원하지 않습니다. 이미지를 사용해 주세요.",
            );
          const selected = await settingsBridge.prepareFiles(textFiles);
          commitPrepared(owner, "files", selected);
        }
      } catch (error) {
        setAttachmentError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [addDroppedImages, commitPrepared, sessionId, settingsBridge],
  );

  useEffect(() => {
    effortValueRef.current = currentEffort;
  }, [currentEffort]);

  // Park the outgoing session's draft and restore the incoming one. Held requests
  // move with it: they were never sent, so they belong to the session that typed
  // them and must not be released into a different one.
  useEffect(() => {
    const previous = draftSessionRef.current;
    if (previous === sessionId) return;
    draftSessionRef.current = sessionId;
    parkDraft(draftsRef.current, previous, {
      value: valueRef.current,
      images: imagesRef.current,
      files: filesRef.current,
    });
    const prepared = pendingPreparedRef.current.get(previous);
    if (prepared) {
      const draft = draftsRef.current.get(previous)!;
      draft.images = mergePreparedAttachments(draft.images, prepared.images, 6);
      draft.files = mergePreparedAttachments(draft.files, prepared.files, 5);
      pendingPreparedRef.current.delete(previous);
    }
    const nextQueue = parkComposerSession(
      previous,
      pendingQueueRef.current,
      sessionId,
    );

    const restored = restoreDraft(draftsRef.current, sessionId);
    valueRef.current = restored.value;
    imagesRef.current = restored.images;
    filesRef.current = restored.files;
    setValue(restored.value);
    setImages(restored.images);
    setFiles(restored.files);
    setPendingQueue(nextQueue);
    setAttachmentError("");
    queueMicrotask(() => {
      setHistoryCursor(-1);
      historyDraftRef.current = "";
    });
  }, [sessionId]);

  useEffect(() => () => {
    for (const [owner, draft] of draftsRef.current) {
      saveComposerSnapshot(composerSnapshots, owner, {
        ...draft,
        pendingQueue: composerQueue(owner),
      });
    }
    saveComposerSnapshot(composerSnapshots, sessionId, {
      value: valueRef.current,
      images: imagesRef.current,
      files: filesRef.current,
      pendingQueue: pendingQueueRef.current,
    });
  }, [sessionId]);

  // Keep the module snapshot current while this composer is mounted. The shell
  // releases queues for sessions whose screen is gone, and the chips must reflect
  // a release that started elsewhere.
  useEffect(() => {
    const applyRecoveries = (): void => {
      if (draftSessionRef.current !== sessionId) return;
      const entries = composerDraftRecoveries(sessionId);
      if (entries.length === 0) return;
      const recovered: MessageInput[] = [];
      let throughRevision = 0;
      for (const entry of entries) {
        const draft = restoreRejectedDraft(
          draftSessionRef.current,
          draftsRef.current,
          sessionId,
          entry.input,
        );
        if (!draft) continue;
        recovered.push({
          text: draft.value,
          images: draft.images,
          files: draft.files,
        });
        throughRevision = entry.revision;
      }
      if (recovered.length === 0) return;
      const merged = mergeRecoveredDraft(
        {
          value: valueRef.current,
          images: imagesRef.current,
          files: filesRef.current,
        },
        recovered,
      );
      valueRef.current = merged.value;
      imagesRef.current = merged.images;
      filesRef.current = merged.files;
      saveComposerSnapshot(composerSnapshots, sessionId, {
        ...merged,
        pendingQueue: pendingQueueRef.current,
      });
      acknowledgeComposerDraftRecoveries(sessionId, throughRevision);
      setValue(merged.value);
      setImages(merged.images);
      setFiles(merged.files);
      setAttachmentError(
        "전송 결과를 확인할 수 없습니다. 대화 기록을 확인한 뒤 다시 전송하세요.",
      );
    };
    const unsubscribe = subscribeComposerDraftRecovery(
      sessionId,
      applyRecoveries,
    );
    // A failure that landed before this instance mounted is already queued.
    applyRecoveries();
    return unsubscribe;
  }, [sessionId]);

  useEffect(() => {
    saveComposerSnapshot(composerSnapshots, sessionId, {
      value: valueRef.current,
      images: imagesRef.current,
      files: filesRef.current,
      pendingQueue,
    });
    saveComposerQueue(sessionId, pendingQueue);
  }, [pendingQueue, sessionId]);

  useEffect(
    () =>
      subscribeComposerQueue(sessionId, () => {
        const pending = composerQueue(sessionId);
        pendingQueueRef.current = pending;
        setPendingQueue(pending);
      }),
    [sessionId],
  );

  useEffect(() => {
    function applyEffortCycle(): void {
      setConfigMenu(null);
      onCycleThinking();
    }
    function handleKeyboard(event: globalThis.KeyboardEvent): void {
      if (
        !event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key !== "Tab"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      applyEffortCycle();
    }
    const unsubscribeNative =
      window.agentControlDesktop?.onCycleEffort(applyEffortCycle);
    window.addEventListener("keydown", handleKeyboard, true);
    return () => {
      unsubscribeNative?.();
      window.removeEventListener("keydown", handleKeyboard, true);
    };
  }, [onCycleThinking]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // Measuring the live field at height:auto temporarily shrinks its flex sibling,
    // the transcript. The browser can clamp scrollTop during that layout read even
    // when the final textarea height is unchanged. Measure outside the layout flow.
    const measure = textarea.cloneNode(false) as HTMLTextAreaElement;
    measure.removeAttribute("id");
    measure.removeAttribute("name");
    measure.setAttribute("aria-hidden", "true");
    measure.tabIndex = -1;
    Object.assign(measure.style, {
      position: "fixed",
      visibility: "hidden",
      pointerEvents: "none",
      width: `${textarea.offsetWidth}px`,
      height: "0px",
      minHeight: "0px",
      maxHeight: "none",
      overflow: "hidden",
      transition: "none",
    });
    measure.value = value;
    textarea.parentElement!.appendChild(measure);
    const height = measure.scrollHeight;
    measure.remove();
    const nextHeight = `${Math.min(Math.max(height, 52), 196)}px`;
    if (textarea.style.height !== nextHeight) textarea.style.height = nextHeight;
    textarea.style.overflowY = height > 196 ? "auto" : "hidden";
  }, [value]);

  useEffect(() => {
    setCommandIndex(0);
  }, [commandQuery]);

  useLayoutEffect(() => {
    const palette = commandPaletteRef.current;
    const selected = palette?.querySelector<HTMLElement>(
      `[data-command-index="${commandIndex}"]`,
    );
    if (!palette || !selected) return;
    const selectedTop = selected.offsetTop;
    const selectedBottom = selectedTop + selected.offsetHeight;
    const visibleTop = palette.scrollTop;
    const visibleBottom = visibleTop + palette.clientHeight;
    if (selectedTop < visibleTop) palette.scrollTop = selectedTop;
    else if (selectedBottom > visibleBottom)
      palette.scrollTop = selectedBottom - palette.clientHeight;
  }, [commandIndex, commandQuery, matchingCommands.length]);

  useEffect(() => {
    function closePopovers(event: Event): void {
      if (
        event.type === "pointerdown" &&
        composerRef.current?.contains(event.target as Node)
      )
        return;
      setWorkspaceOpen(false);
      setConfigMenu(null);
    }
    window.addEventListener("pointerdown", closePopovers);
    window.addEventListener("blur", closePopovers);
    return () => {
      window.removeEventListener("pointerdown", closePopovers);
      window.removeEventListener("blur", closePopovers);
    };
  }, []);

  useEffect(() => {
    const candidate = composerRef.current?.closest(".app-shell");
    if (!(candidate instanceof HTMLElement)) return;
    const dropTarget = candidate;
    let dragDepth = 0;
    function hasFiles(event: DragEvent): boolean {
      return event.dataTransfer?.types.includes("Files") ?? false;
    }
    function handleDragEnter(event: DragEvent): void {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      dropTarget.classList.add("is-dragging-files");
      setDragActive(true);
    }
    function handleDragOver(event: DragEvent): void {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function handleDragLeave(event: DragEvent): void {
      if (dragDepth === 0) return;
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth > 0) return;
      dropTarget.classList.remove("is-dragging-files");
      setDragActive(false);
    }
    function handleDrop(event: DragEvent): void {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      dragDepth = 0;
      dropTarget.classList.remove("is-dragging-files");
      setDragActive(false);
      void addDroppedAttachments(event.dataTransfer.files);
    }
    dropTarget.addEventListener("dragenter", handleDragEnter);
    dropTarget.addEventListener("dragover", handleDragOver);
    dropTarget.addEventListener("dragleave", handleDragLeave);
    dropTarget.addEventListener("drop", handleDrop);
    return () => {
      dropTarget.classList.remove("is-dragging-files");
      dropTarget.removeEventListener("dragenter", handleDragEnter);
      dropTarget.removeEventListener("dragover", handleDragOver);
      dropTarget.removeEventListener("dragleave", handleDragLeave);
      dropTarget.removeEventListener("drop", handleDrop);
    };
  }, [addDroppedAttachments]);


  // Interrupt the open turn, then hand the held requests over in order. Each entry
  // leaves the queue only after onSend resolves for it, so a failed release keeps
  // the request visible instead of losing the user's text.
  const releasePendingQueue = useCallback(async (): Promise<void> => {
    if (readOnly || releasingQueues.has(sessionId) || draftSessionRef.current !== sessionId) return;
    const owner = sessionId;
    const read = (): PendingRequest[] =>
      draftSessionRef.current === owner
        ? pendingQueueRef.current
        : composerQueue(owner);
    const write = (pending: PendingRequest[]): void => {
      // The session's module snapshot is the one queue every observer shares.
      // Never write from an instance-local copy: this loop may outlive the
      // composer that started it, and a later switch would republish that copy.
      saveComposerQueue(owner, pending);
      if (draftSessionRef.current !== owner) return;
      pendingQueueRef.current = pending;
      if (mountedRef.current) setPendingQueue(pending);
    };
    if (read()[0]?.blocked) return;
    releasingQueues.add(owner);
    try {
      // Only an open turn needs interrupting. Aborting an idle session would
      // cancel nothing and emit a spurious cancellation notice.
      if (running) await onFlushQueued();
      await releaseRequests({
        canSend: () =>
          canReleaseQueue(
            mountedRef.current,
            draftSessionRef.current,
            owner,
          ),
        read,
        write,
        send: (request) =>
          onSend({
            text: request.text,
            images: request.images,
            files: request.files,
          }),
      });
    } catch (error) {
      // A failed flush must not restart the release loop on its idle event.
      const pending = read();
      if (pending[0]) write([{ ...pending[0], blocked: true }, ...pending.slice(1)]);
      if (draftSessionRef.current === owner) setAttachmentError(humanErrorMessage(error));
    } finally {
      releasingQueues.delete(owner);
      requestQueueReleaseRetry(owner, read());
    }
  }, [onFlushQueued, onSend, running, readOnly, sessionId]);

  // A pull takes one held request back into the draft the user is editing. The
  // queue is written through its ref first for the same reason the release loop
  // does it: the next gesture must see what this one has already removed.
  function pullQueuedEntry(target: QueuePullTarget): void {
    // A release in flight is handing entries over one at a time from this same
    // queue, so a pull beside it would race that loop for the entry it claimed.
    if (releasingQueues.has(sessionId)) return;
    const pulled = pullQueuedRequest(pendingQueueRef.current, target);
    if (!pulled) return;
    pendingQueueRef.current = pulled.pending;
    setPendingQueue(pulled.pending);
    const restored = restorePulledDraft(
      {
        value: valueRef.current,
        images: imagesRef.current,
        files: filesRef.current,
      },
      pulled.entry,
    );
    setValue(restored.value);
    setImages(restored.images);
    setFiles(restored.files);
    // The draft just stopped being the history entry the cursor was on, so the
    // cursor leaves history mode the way an edit makes it.
    setHistoryCursor(-1);
    historyDraftRef.current = "";
    // The gesture may have been a click on a chip, which pulled focus onto that
    // button. The pulled text is the thing to keep editing, so the caret goes to
    // its end after the state has flushed.
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(restored.value.length, restored.value.length);
    });
  }

  // A chip's × discards exactly that entry. Same guard as a pull: the release
  // loop may be awaiting a send for an entry it has already claimed.
  function discardQueuedEntry(id: string): void {
    if (releasingQueues.has(sessionId)) return;
    const remaining = withoutReleasedRequest(pendingQueueRef.current, id);
    pendingQueueRef.current = remaining;
    setPendingQueue(remaining);
  }

  // Held requests exist only because a turn was open. Once that turn ends they
  // are sent without waiting for another gesture -- otherwise the queue is
  // unreachable (submit() keeps appending while anything is held) and every later
  // message piles up behind it silently.
  //
  // This drains on the running -> idle transition only. Draining whenever
  // `running` merely reads false would fire in the gap between a submit and the
  // backend reporting the turn, releasing the queue into a turn that is still
  // starting up. It has to sit after `releasePendingQueue` because the effect
  // closes over the callback it calls.
  const wasRunningRef = useRef({ sessionId, running });
  useEffect(() => {
    const previous = wasRunningRef.current;
    const turnEnded = previous.sessionId === sessionId && previous.running && !running;
    wasRunningRef.current = { sessionId, running };
    if (!turnEnded || pendingQueueRef.current.length === 0) return;
    void releasePendingQueue();
  }, [releasePendingQueue, running, sessionId]);

  function submit(): void {
    if (readOnly) {
      setAttachmentError("보기 전용 기기입니다. 조작은 데스크톱에서 해주세요.");
      return;
    }
    const content = (textareaRef.current?.value ?? value).trim();
    if (
      content &&
      isDuplicateSubmission(
        lastSubmissionRef.current,
        content,
        performance.now(),
      )
    )
      return;
    const submission = content
      ? { text: content, at: performance.now() }
      : undefined;
    if (submission) lastSubmissionRef.current = submission;
    // GJC CLI semantics: an empty submit interrupts a live run and releases the
    // queue this composer has been holding. With nothing held it is a no-op.
    if (!content && images.length === 0 && files.length === 0) {
      if (pendingQueue.length === 0) return;
      void releasePendingQueue();
      return;
    }
    const modelCommand = content.match(/^\/(?:model|models)(?:\s+(.+))?$/iu);
    if (modelCommand && images.length === 0 && files.length === 0) {
      const query = modelCommand[1]?.trim();
      if (!query) {
        if (modelOption) {
          setValue("");
          setConfigMenu(modelOption.id);
        }
        return;
      }
      const preset = resolveModelPreset(query, modelOption?.options);
      if (!preset) {
        setAttachmentError(`알 수 없는 모델 프리셋: ${query}`);
        return;
      }
      onConfigChange(modelOption?.id ?? "model", preset);
      setValue("");
      setConfigMenu(null);
      setAttachmentError("");
      return;
    }
    if (content) {
      const history = promptHistoryRef.current.get(sessionId) ?? [];
      if (history.at(-1) !== content)
        promptHistoryRef.current.set(
          sessionId,
          [...history, content].slice(-100),
        );
    }
    const liveTurn = running || pendingQueue.length > 0;
    const immediateSdkCommand = isImmediateSdkCommandSubmission(
      content,
      commands,
      images.length > 0 || files.length > 0,
    );
    if (liveTurn && !immediateSdkCommand) {
      // Held locally, not sent. GJC consumes turn.steer into the open turn the
      // moment it arrives, so submitting now would run the request against the
      // turn the user is still waiting on.
      const preview = composerQueuePreview(content, files, images);
      setPendingQueue((current) =>
        appendPendingRequest(current, {
          id: `local-${crypto.randomUUID()}`,
          text: preview.text,
          mode: preview.mode,
          label: preview.mode === "steer" ? "Steer" : "Queued",
          images,
          files,
        }),
      );
    } else {
      // SDK slash commands are controls/queries, not prompts. They remain useful
      // while a turn is running and must not sit behind the composer's follow-up
      // queue, where they would execute only after the work they are inspecting.
      // Immediate commands are intentionally fire-and-forget. The shell has
      // already surfaced delivery failures, so consume this promise here rather
      // than creating an unhandled renderer rejection.
      const owner = sessionId;
      const input = { text: content, images, files };
      void onSend(input).catch(() => {
        if (submission && lastSubmissionRef.current === submission)
          lastSubmissionRef.current = { text: "", at: 0 };
        restoreRejectedSubmission(owner, input);
      });
    }
    // submit() reads the textarea's DOM value, so clearing React state alone left
    // the same text readable until the next render. A second Enter arriving in that
    // window -- routine with the Korean IME, which submits from a rAF callback and
    // from the form handler -- queued the request twice.
    if (textareaRef.current) textareaRef.current.value = "";
    setValue("");
    setHistoryCursor(-1);
    historyDraftRef.current = "";
    setImages([]);
    setFiles([]);
    // Clicking the send arrow removes that focused button when the draft clears and
    // leaves focus on <body>. The advertised second Enter can only reach handleKeyDown
    // when the textarea owns focus, so restore it after every submission.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function acceptImages(selectedFiles: FileList | null): Promise<void> {
    if (!selectedFiles?.length || choosingImages) return;
    const owner = sessionId;
    setAttachmentError("");
    setChoosingImages(true);
    try {
      // Without the desktop bridge this is the remote client: a picked file is
      // read straight into the message instead of through a native path lease.
      const selected = settingsBridge
        ? await settingsBridge.prepareImages(Array.from(selectedFiles))
        : await droppedImageAttachments(Array.from(selectedFiles), imagesRef.current.length);
      if (selected.length > 0) commitPrepared(owner, "images", selected);
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setChoosingImages(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  }

  async function acceptFiles(selectedFiles: FileList | null): Promise<void> {
    if (!selectedFiles?.length) return;
    const owner = sessionId;
    if (!settingsBridge) {
      setAttachmentError(
        "원격 연결에서는 파일 첨부를 지원하지 않습니다. 이미지를 사용해 주세요.",
      );
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setAttachmentError("");
    try {
      const selected = await settingsBridge.prepareFiles(Array.from(selectedFiles));
      commitPrepared(owner, "files", selected);
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function browseWorkspace(): Promise<void> {
    if (!settingsBridge) {
      setWorkspaceOpen(false);
      setAttachmentError("원격 연결에서는 워크스페이스를 바꿀 수 없습니다.");
      return;
    }
    setWorkspaceOpen(false);
    try {
      const selected = await settingsBridge.chooseWorkspace(workspace);
      if (selected && selected !== workspace) onWorkspaceChange(selected);
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function selectCommand(command: AgentCommand): void {
    if (command.name === "abort") {
      setValue("");
      if (running) {
        discardQueueAfterCancel(sessionId);
      } else setAttachmentError("중단할 실행 작업이 없습니다");
      return;
    }
    if (command.name === "steer") {
      setValue("/steer ");
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (command.name === "compact") {
      setValue("");
      onCompact();
      return;
    }
    if (command.name === "new") {
      setValue("");
      onNewSession();
      return;
    }
    if (command.name === "model" && modelOption) {
      setValue("");
      setConfigMenu(modelOption.id);
      return;
    }
    if (command.name === "effort" && thinkingOption) {
      setValue("");
      setConfigMenu(thinkingOption.id);
      return;
    }
    if (!command.hint && !command.name.startsWith("skill:")) {
      // A completed no-argument SDK command would otherwise leave the exact `/name`
      // query in the textarea. The palette stays open for that value, so every later
      // Enter selects it again and the command can never reach submit(). Selection is
      // the complete action for a command with no input to collect.
      setValue("");
      setCommandIndex(0);
      // Palette commands also bypass the pending queue and therefore do not have
      // an awaiting caller. Delivery errors are surfaced by the shell; consume
      // the rejection locally to keep it out of the renderer's unhandled queue.
      void onSend({ text: `/${command.name}`, images: [], files: [] }).catch(
        () => undefined,
      );
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    setValue(selectedCommandDraft(command.name));
    setCommandIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function selectConfig(configId: string, selectedValue: string): void {
    onConfigChange(configId, selectedValue);
    setConfigMenu(null);
  }

  // Fast is applied by the runtime, not by this component: the buttons render the
  // serviceTier the session reports, and a refused request is surfaced here instead
  // of flipping the control. The send goes straight to onSend rather than through
  // submit() on purpose -- the composer's queue holds prompt work for after the open
  // turn, while a control sent from a running session has to reach the runtime now.
  async function setFastTier(fast: boolean): Promise<void> {
    if (readOnly || fastTierBusy(fastRequestRef.current, sessionId)) return;
    const request: FastTierRequest = { sessionId };
    fastRequestRef.current = request;
    setFastRequest(request);
    setAttachmentError("");
    try {
      await requestFastTier({ fast, send: onSend, report: setAttachmentError });
    } finally {
      if (fastRequestRef.current === request) fastRequestRef.current = null;
      // Only the request that is still current may clear the busy state: a refusal
      // from an abandoned session must not unlock a later request's button.
      setFastRequest((current) => (current === request ? null : current));
    }
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape" || event.key === "Esc") {
      setWorkspaceOpen(false);
      setConfigMenu(null);
      if (matchingCommands.length > 0) setValue("");
      if (running && !event.metaKey && !event.ctrlKey && !event.altKey)
        discardQueueAfterCancel(sessionId);
      else setPendingQueue([]);
      return;
    }
    // Pulling a held request back is decided before anything else that watches the
    // arrow keys, and only consumes the keydown when a pull can actually happen.
    const pull = consumeQueuePullKey(event, {
      pending: pendingQueueRef.current,
      releasing: releasingQueues.has(sessionId),
    });
    if (pull) {
      pullQueuedEntry(pull);
      return;
    }
    const textarea = event.currentTarget;
    // Every Enter path that can submit is owned by handleComposerEnter, including
    // the Shift+Enter newline it refuses to consume. Its doc carries the IME story
    // that used to sit inline here.
    if (
      handleComposerEnter(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          composing:
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            composingRef.current,
          compositionEndedAt: compositionEndedAtRef.current,
          now: performance.now(),
          draftEmpty: !textarea.value.trim(),
          paletteOpen: matchingCommands.length > 0,
        },
        {
          preventDefault: () => event.preventDefault(),
          submit,
          arm: (at) => {
            submitAfterCompositionRef.current = true;
            enterArmedAtRef.current = at;
          },
          disarm: () => {
            submitAfterCompositionRef.current = false;
            enterArmedAtRef.current = 0;
          },
          defer: () => {
            if (compositionSubmitScheduledRef.current) return;
            compositionSubmitScheduledRef.current = true;
            requestAnimationFrame(() => {
              compositionSubmitScheduledRef.current = false;
              submit();
            });
          },
        },
      )
    )
      return;
    if (matchingCommands.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCommandIndex((current) => (current + 1) % matchingCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCommandIndex(
          (current) =>
            (current - 1 + matchingCommands.length) % matchingCommands.length,
        );
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        selectCommand(
          matchingCommands[
            Math.min(commandIndex, matchingCommands.length - 1)
          ]!,
        );
        return;
      }
    }
    const history = promptHistoryRef.current.get(sessionId) ?? [];
    const plainArrow =
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (
      plainArrow &&
      event.key === "ArrowUp" &&
      history.length > 0 &&
      (!value.includes("\n") || textarea.selectionStart === 0)
    ) {
      event.preventDefault();
      const nextCursor =
        historyCursor < 0 ? history.length - 1 : Math.max(0, historyCursor - 1);
      if (historyCursor < 0) historyDraftRef.current = value;
      setHistoryCursor(nextCursor);
      setValue(history[nextCursor] ?? "");
      requestAnimationFrame(() =>
        textareaRef.current?.setSelectionRange(
          history[nextCursor]?.length ?? 0,
          history[nextCursor]?.length ?? 0,
        ),
      );
      return;
    }
    if (
      plainArrow &&
      event.key === "ArrowDown" &&
      historyCursor >= 0 &&
      (!value.includes("\n") || textarea.selectionStart === value.length)
    ) {
      event.preventDefault();
      const nextCursor = historyCursor + 1;
      if (nextCursor >= history.length) {
        setHistoryCursor(-1);
        setValue(historyDraftRef.current);
        requestAnimationFrame(() =>
          textareaRef.current?.setSelectionRange(
            historyDraftRef.current.length,
            historyDraftRef.current.length,
          ),
        );
      } else {
        setHistoryCursor(nextCursor);
        setValue(history[nextCursor] ?? "");
        requestAnimationFrame(() =>
          textareaRef.current?.setSelectionRange(
            history[nextCursor]?.length ?? 0,
            history[nextCursor]?.length ?? 0,
          ),
        );
      }
      return;
    }
  }

  return (
    <form
      ref={composerRef}
      className={`composer ${dragActive ? "is-dragging" : ""}`}
      onSubmit={handleSubmit}
    >
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((image) => (
            <span key={image.id}>
              <img
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={image.name}
              />
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => {
                  discardPrepared([image]);
                  setImages((current) =>
                    current.filter((item) => item.id !== image.id),
                  );
                }}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((file) => (
            <span className="attachment-chip" key={file.id}>
              <span>{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => {
                  discardPrepared([file]);
                  setFiles((current) =>
                    current.filter((item) => item.id !== file.id),
                  );
                }}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {readOnly && (
        <small className="composer-readonly">
          보기 전용 기기입니다. 이 기기에서는 대화 조회만 가능합니다.
        </small>
      )}
      {attachmentError && (
        <small className="composer-error">{attachmentError}</small>
      )}
      {pendingQueue.length > 0 && (
        <span className={`composer-queue${pendingQueue[0]?.blocked ? " composer-queue--blocked" : ""}`}>
          <strong>{pendingQueue[0]?.blocked ? "자동 전송 중지" : `${pendingQueue.length}개 대기 중`}</strong>
          <span className="composer-queue-items">
            {pendingQueue.map((entry) => (
              <QueueChip
                key={entry.id}
                entry={entry}
                onPull={() => pullQueuedEntry({ id: entry.id })}
                onDiscard={() => discardQueuedEntry(entry.id)}
              />
            ))}
          </span>
          <small role={pendingQueue[0]?.blocked ? "status" : undefined}>
            {pendingQueue[0]?.blocked
              ? "이미 처리됐을 수 있습니다. 대화 기록을 확인한 뒤 항목을 꺼내거나 버리세요."
              : "Enter 한 번 더 = 바로 실행 · ⌥↑/⌥↓ = 꺼내기 · 항목 클릭 = 꺼내기"}
          </small>
        </span>
      )}
      {draftUrl && <LinkPreviewCard url={draftUrl} compact />}
      <textarea
        ref={textareaRef}
        aria-label={`${sessionTitle}에게 메시지 보내기`}
        placeholder={readOnly ? "보기 전용 기기입니다" : "무엇이든 요청하세요"}
        rows={1}
        value={value}
        disabled={readOnly}
        onChange={(event) => {
          setValue(event.target.value);
          setHistoryCursor(-1);
          historyDraftRef.current = "";
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          compositionEndedAtRef.current = performance.now();
          if (
            !submitAfterCompositionRef.current ||
            compositionSubmitScheduledRef.current
          )
            return;
          // Only the Enter that armed this commit may submit it. An Enter armed
          // long ago belongs to text the user has since edited.
          const armed = imeCommitSubmits(
            enterArmedAtRef.current,
            performance.now(),
          );
          submitAfterCompositionRef.current = false;
          if (!armed) return;
          compositionSubmitScheduledRef.current = true;
          requestAnimationFrame(() => {
            compositionSubmitScheduledRef.current = false;
            submit();
          });
        }}
        onKeyDown={handleKeyDown}
      />
      {matchingCommands.length > 0 && (
        <div className="command-palette" ref={commandPaletteRef}>
          <header>
            <Sparkles size={14} /> 스킬 및 명령어
            <span className="command-palette-count">{matchingCommands.length}</span>
            <span className="command-palette-help">↑↓ 선택 · Enter 적용</span>
          </header>
          {matchingCommands.map((command, index) => (
            <button
              key={command.name}
              type="button"
              data-command-index={index}
              className={`command-palette-item${index === commandIndex ? " is-selected" : ""}${command.name.startsWith("skill:") ? " is-skill" : ""}`}
              aria-label={`/${command.name}${command.description ? ` — ${command.description}` : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectCommand(command)}
            >
              <span className="command-palette-icon" aria-hidden>
                {command.name.startsWith("skill:") ? <Sparkles size={15} /> : <Command size={15} />}
              </span>
              <span className="command-palette-copy">
                <strong>{command.name.startsWith("skill:") ? command.name.slice(6) : `/${command.name}`}</strong>
                <small title={command.description}>{command.description}</small>
              </span>
              <span className="command-palette-meta">
                {command.name.startsWith("skill:") && <span className="command-skill-badge">스킬</span>}
                {command.hint && <code>{command.hint}</code>}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-toolbar">
        <div>
          <input
            ref={imageInputRef}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={(event) => void acceptImages(event.currentTarget.files)}
          />
          <input
            ref={fileInputRef}
            hidden
            type="file"
            multiple
            onChange={(event) => void acceptFiles(event.currentTarget.files)}
          />
          <button
            className="icon-button"
            type="button"
            title="이미지 첨부"
            disabled={readOnly || images.length >= 6}
            aria-busy={choosingImages}
            onClick={() => imageInputRef.current?.click()}
          >
            <Paperclip size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="파일 첨부"
            disabled={files.length >= 5}
            onClick={() => fileInputRef.current?.click()}
          >
            <FolderOpen size={16} />
          </button>
          <span className="workspace-switcher">
            <button
              className="composer-context"
              type="button"
              title={workspace}
              onClick={() => setWorkspaceOpen((open) => !open)}
            >
              <FolderGit2 size={15} /> {directoryName(workspace)}{" "}
              <ChevronDown size={13} />
            </button>
            {workspaceOpen && (
              <span className="workspace-menu">
                <strong>세션을 시작할 workspace</strong>
                {workspaces.map((candidate) => (
                  <button
                    type="button"
                    key={candidate}
                    className={candidate === workspace ? "is-current" : ""}
                    onClick={() => {
                      setWorkspaceOpen(false);
                      if (candidate !== workspace) onWorkspaceChange(candidate);
                    }}
                  >
                    <FolderGit2 size={14} />
                    <span>
                      {directoryName(candidate)}
                      <small>{candidate}</small>
                    </span>
                    {candidate === workspace && <Check size={13} />}
                  </button>
                ))}
                <button type="button" onClick={() => void browseWorkspace()}>
                  <FolderOpen size={14} />
                  <span>다른 폴더 선택…</span>
                </button>
              </span>
            )}
          </span>
          {modelOption && (
            <span className="composer-model">
              {/* Left enabled during a run: this popover is where the Fast tier is
                  switched, and the runtime applies a tier to the open session. A
                  model change mid-turn is refused by the runtime and surfaced by the
                  shell, which is better than hiding both controls until the turn ends. */}
              <button
                type="button"
                title="Model: /model · Effort: ⇧⇥"
                onClick={() =>
                  setConfigMenu((open) =>
                    open === modelOption.id ? null : modelOption.id,
                  )
                }
              >
                <strong>
                  {modelDisplay ??
                    modelOption.options?.find(
                      (choice) => choice.value === modelOption.currentValue,
                    )?.name ??
                    String(modelOption.currentValue)}
                </strong>
                <i />
                <span>{currentEffort}</span>
                <i />
                <span>
                  {usagePercent === undefined
                    ? "—"
                    : `${usagePercent.toFixed(1)}%`}
                </span>
                {fastMode && (
                  <>
                    <i />
                    <span
                      className="composer-fast-mode"
                      title="Fast 모드 켜짐"
                      aria-label="Fast 모드 켜짐"
                    >
                      <Zap size={10} aria-hidden="true" />
                      Fast
                    </span>
                  </>
                )}
              </button>
              {configMenu === modelOption.id && (
                <span className="config-option-menu config-option-menu--model">
                  <header>
                    <strong>모델 프로필</strong>
                    <FastTierControls
                      commands={commands}
                      fastMode={fastMode}
                      busy={fastBusy}
                      readOnly={readOnly}
                      onSelect={(fast) => void setFastTier(fast)}
                    />
                    <small>
                      {modelOption.options?.length ?? 0}개 사용 가능
                    </small>
                  </header>
                  <span className="config-option-scroll">
                    {configOptionGroups(modelOption.options).map((group) => (
                      <span className="config-option-group" key={group.name}>
                        <strong>{group.name}</strong>
                        {group.options.map((choice) => (
                          <button
                            key={choice.value}
                            type="button"
                            className={
                              choice.value === modelOption.currentValue
                                ? "is-current"
                                : ""
                            }
                            onClick={() =>
                              selectConfig(modelOption.id, choice.value)
                            }
                          >
                            <span>
                              <strong>{choice.name}</strong>
                              {choice.description && (
                                <small>{choice.description}</small>
                              )}
                            </span>
                            {choice.value === modelOption.currentValue && (
                              <Check size={13} />
                            )}
                          </button>
                        ))}
                      </span>
                    ))}
                  </span>
                </span>
              )}
              {thinkingOption && configMenu === thinkingOption.id && (
                <span className="config-option-menu config-option-menu--effort">
                  <header>
                    <strong>추론 Effort</strong>
                    <small>⇧⇥</small>
                  </header>
                  {thinkingOption.options?.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      className={
                        choice.value === thinkingOption.currentValue
                          ? "is-current"
                          : ""
                      }
                      onClick={() =>
                        selectConfig(thinkingOption.id, choice.value)
                      }
                    >
                      <span>{choice.name}</span>
                      {choice.value === thinkingOption.currentValue && (
                        <Check size={12} />
                      )}
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="composer-submit-actions">
          {/* One button, two states. Something to submit always wins: while a turn
              runs, typed text is queued or steered, so the arrow has to stay
              reachable. With an empty composer during a turn the same slot stops
              it. Rendering both at once left two buttons side by side. */}
          {hasDraft ? (
            <button
              className="send-button"
              type="submit"
              disabled={readOnly}
              title={running ? "이어서 보내기" : "메시지 보내기"}
            >
              <ArrowUp size={18} />
            </button>
          ) : (
            <button
              className="send-button send-button--stop"
              type="button"
              disabled={!running || readOnly}
              onClick={() => discardQueueAfterCancel(sessionId)}
              title="작업 중단 (Esc)"
            >
              <CircleStop size={18} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
