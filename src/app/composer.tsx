import type { FileAttachment, MessageDelivery } from "../../shared/agent-contract";
import type { AgentCommand, AgentConfigOption, ImageAttachment, MessageInput } from "../backend/types";
import {
  appendPendingRequest,
  composerQueuePreview,
  droppedImageAttachments,
  imeCommitSubmits,
  isImmediateSdkCommandSubmission,
  isDuplicateSubmission,
  parkDraft,
  releaseRequests,
  resolveModelPreset,
  restoreDraft,
} from "../composer-utils";
import type { PendingRequest } from "../composer-utils";
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleStop,
  Command,
  FolderGit2,
  FolderOpen,
  Paperclip,
  Zap,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { configOptionGroups, directoryName, httpUrls } from "./format";
import { LinkPreviewCard } from "./primitives";

const FAST_SERVICE_TIERS = new Set([
  "priority",
  "openai-only",
  "claude-only",
]);

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
  onCancel: () => void;
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
  const [value, setValue] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
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
  const [pendingQueue, setPendingQueue] = useState<PendingRequest[]>([]);
  const [historyCursor, setHistoryCursor] = useState(-1);
  // A draft belongs to the session it was typed in. The composer is one mounted
  // component for every session, so unsent text has to be parked per session or
  // switching rows would carry it along and let it be sent to the wrong agent.
  const draftsRef = useRef(
    new Map<
      string,
      { value: string; images: ImageAttachment[]; files: FileAttachment[] }
    >(),
  );
  const draftSessionRef = useRef(sessionId);
  const pendingQueuesRef = useRef(new Map<string, PendingRequest[]>());
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

  const addDroppedImages = useCallback(
    async (files: FileList | readonly File[]): Promise<void> => {
      setAttachmentError("");
      try {
        if (images.length + files.length > 6)
          throw new Error("이미지는 메시지당 최대 6장까지 첨부할 수 있습니다");
        const all = Array.from(files);
        // Only a file selected or dragged from the OS has a main-authorizable
        // native identity. Browser-originated images stay inline; an actual native
        // validation failure must surface rather than silently bypassing the main
        // process capability boundary.
        if (!settingsBridge) {
          const inline = await droppedImageAttachments(all, images.length);
          setImages((current) => [...current, ...inline]);
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
              images.length + attachments.length,
            )
          : [];
        setImages((current) => [...current, ...attachments, ...inline]);
      } catch (error) {
        setAttachmentError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [images.length, settingsBridge],
  );

  const addDroppedAttachments = useCallback(
    async (dropped: FileList | readonly File[]): Promise<void> => {
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
          const combined = [...files, ...selected];
          discardPrepared(combined.slice(5));
          setFiles(combined.slice(0, 5));
        }
      } catch (error) {
        setAttachmentError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [addDroppedImages, discardPrepared, files, settingsBridge],
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
    if (pendingQueueRef.current.length > 0)
      pendingQueuesRef.current.set(previous, pendingQueueRef.current);
    else pendingQueuesRef.current.delete(previous);

    const restored = restoreDraft(draftsRef.current, sessionId);
    setValue(restored.value);
    setImages(restored.images);
    setFiles(restored.files);
    setPendingQueue(pendingQueuesRef.current.get(sessionId) ?? []);
    setAttachmentError("");
    queueMicrotask(() => {
      setHistoryCursor(-1);
      historyDraftRef.current = "";
    });
  }, [sessionId]);

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
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 52), 196)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 196 ? "auto" : "hidden";
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

  const releasingRef = useRef(false);

  // Interrupt the open turn, then hand the held requests over in order. Each entry
  // leaves the queue only after onSend resolves for it, so a failed release keeps
  // the request visible instead of losing the user's text.
  const releasePendingQueue = useCallback(async (): Promise<void> => {
    if (releasingRef.current) return;
    releasingRef.current = true;
    try {
      // Only an open turn needs interrupting. Aborting an idle session would
      // cancel nothing and emit a spurious cancellation notice.
      if (running) await onFlushQueued();
      await releaseRequests({
        read: () => pendingQueueRef.current,
        write: (pending) => {
          pendingQueueRef.current = pending;
          setPendingQueue(pending);
        },
        send: (request) =>
          onSend({
            text: request.text,
            images: request.images,
            files: request.files,
          }),
      });
    } finally {
      releasingRef.current = false;
    }
  }, [onFlushQueued, onSend, running]);

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
  const wasRunningRef = useRef(running);
  useEffect(() => {
    const turnEnded = wasRunningRef.current && !running;
    wasRunningRef.current = running;
    if (!turnEnded || pendingQueueRef.current.length === 0) return;
    void releasePendingQueue();
  }, [releasePendingQueue, running]);

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
    if (content)
      lastSubmissionRef.current = { text: content, at: performance.now() };
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
      void onSend({ text: content, images, files }).catch(() => undefined);
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
    setAttachmentError("");
    setChoosingImages(true);
    try {
      // Without the desktop bridge this is the remote client: a picked file is
      // read straight into the message instead of through a native path lease.
      const selected = settingsBridge
        ? await settingsBridge.prepareImages(Array.from(selectedFiles))
        : await droppedImageAttachments(Array.from(selectedFiles), images.length);
      if (selected.length > 0) {
        const combined = [...images, ...selected];
        discardPrepared(combined.slice(6));
        setImages(combined.slice(0, 6));
      }
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
      const combined = [...files, ...selected];
      discardPrepared(combined.slice(5));
      setFiles(combined.slice(0, 5));
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
        onCancel();
        setPendingQueue([]);
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
      setPendingQueue([]);
      setWorkspaceOpen(false);
      setConfigMenu(null);
      if (matchingCommands.length > 0) setValue("");
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        onCancel();
      }
      return;
    }
    // macOS Korean IME emits Enter while the final syllable is still composing.
    // Treating that keydown as submit sends the full sentence and then the last
    // syllable again as a second steer (for example "steer 테스트" + "트"), so the
    // submission waits for the IME to commit. It is armed here and fired from
    // compositionend, which is the first moment the final text is readable.
    //
    // This used to be a timer that submitted whatever the textarea held 80ms
    // later. That sent text the user typed *after* the Enter, with no submit of
    // their own -- an uninvited second submission on top of their real one.
    if (
      event.key === "Enter" &&
      (event.nativeEvent.isComposing ||
        event.keyCode === 229 ||
        composingRef.current)
    ) {
      event.preventDefault();
      // An empty draft has nothing left to compose, so this is a real empty
      // submit -- the gesture that interrupts the run and releases the queue.
      if (!(textareaRef.current?.value ?? value).trim()) {
        submitAfterCompositionRef.current = false;
        submit();
        return;
      }
      submitAfterCompositionRef.current = true;
      enterArmedAtRef.current = performance.now();
      return;
    }
    if (
      event.key === "Enter" &&
      performance.now() - compositionEndedAtRef.current < 100
    ) {
      event.preventDefault();
      if (!(textareaRef.current?.value ?? value).trim()) return;
      if (!compositionSubmitScheduledRef.current) {
        compositionSubmitScheduledRef.current = true;
        requestAnimationFrame(() => {
          compositionSubmitScheduledRef.current = false;
          submit();
        });
      }
      return;
    }
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
    const textarea = event.currentTarget;
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
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
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
        <span className="composer-queue">
          <strong>{pendingQueue.length}개 대기 중</strong>
          <span className="composer-queue-items">
            {pendingQueue.map((entry) => (
              <span
                key={entry.id}
                className={`composer-queue-item composer-queue-item--${entry.mode}`}
              >
                <em>{entry.mode === "steer" ? "즉시" : "대기"}</em>
                {entry.text}
              </span>
            ))}
          </span>
          <small>Enter를 한 번 더 누르면 바로 실행합니다</small>
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
            <Command size={14} /> GJC 명령어
          </header>
          {matchingCommands.map((command, index) => (
            <button
              key={command.name}
              type="button"
              data-command-index={index}
              className={index === commandIndex ? "is-selected" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectCommand(command)}
            >
              <span>
                <strong>/{command.name}</strong>
                <small>{command.description}</small>
              </span>
              {command.hint && <code>{command.hint}</code>}
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
              onClick={() => {
                onCancel();
                setPendingQueue([]);
              }}
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
