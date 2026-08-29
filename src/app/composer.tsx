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
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { configOptionGroups, directoryName, httpUrls } from "./format";
import { LinkPreviewCard } from "./primitives";

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
  onSend: (input: MessageInput) => Promise<MessageDelivery | undefined>;
  onCancel: () => void;
  onFlushQueued: () => Promise<void>;
  onCompact: () => void;
  onNewSession: () => void;
  onWorkspaceChange: (workspace: string) => void;
  onConfigChange: (configId: string, value: string) => void;
  onCycleThinking: () => void;
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
  onSend,
  onCancel,
  onFlushQueued,
  onCompact,
  onNewSession,
  onWorkspaceChange,
  onConfigChange,
  onCycleThinking,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [choosingImages, setChoosingImages] = useState(false);
  const [dragActive, setDragActive] = useState(false);
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

  const addDroppedImages = useCallback(
    async (files: FileList | readonly File[]): Promise<void> => {
      if (!settingsBridge) return;
      setAttachmentError("");
      try {
        if (images.length + files.length > 6)
          throw new Error("이미지는 메시지당 최대 6장까지 첨부할 수 있습니다");
        const all = Array.from(files);
        // Only a file dragged from the OS carries a path the main process can
        // read. A drag from a browser or another app has none, so those are read
        // in the renderer instead of failing the whole drop.
        const withPath = all.filter((file) =>
          Boolean(settingsBridge.pathForFile(file)),
        );
        const withoutPath = all.filter(
          (file) => !settingsBridge.pathForFile(file),
        );
        const attachments = withPath.length
          ? await settingsBridge.readImages(
              withPath.map((file) => settingsBridge.pathForFile(file)),
            )
          : [];
        const inline = withoutPath.length
          ? await droppedImageAttachments(
              withoutPath,
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
            throw new Error("파일 읽기 브리지를 사용할 수 없습니다");
          const paths = textFiles.map((file) =>
            settingsBridge.pathForFile(file),
          );
          const selected = await settingsBridge.readFiles(paths);
          setFiles((current) => [...current, ...selected].slice(0, 5));
        }
      } catch (error) {
        setAttachmentError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [addDroppedImages, settingsBridge],
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

  // Held requests exist only because a turn was open. Once that turn ends they
  // are sent without waiting for another gesture -- otherwise the queue is
  // unreachable (submit() keeps appending while anything is held) and every later
  // message piles up behind it silently.
  //
  // This drains on the running -> idle transition only. Draining whenever
  // `running` merely reads false would fire in the gap between a submit and the
  // backend reporting the turn, releasing the queue into a turn that is still
  // starting up.
  const wasRunningRef = useRef(running);
  useEffect(() => {
    const turnEnded = wasRunningRef.current && !running;
    wasRunningRef.current = running;
    if (!turnEnded || pendingQueueRef.current.length === 0) return;
    void releasePendingQueue();
  }, [running]);

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
  async function releasePendingQueue(): Promise<void> {
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
  }

  function submit(): void {
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
      void onSend({ text: content, images, files });
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
    if (!settingsBridge || !selectedFiles?.length || choosingImages) return;
    setAttachmentError("");
    setChoosingImages(true);
    try {
      const paths = Array.from(selectedFiles).map((file) =>
        settingsBridge.pathForFile(file),
      );
      const selected = await settingsBridge.readImages(paths);
      if (selected.length > 0)
        setImages((current) => [...current, ...selected].slice(0, 6));
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
    if (!settingsBridge || !selectedFiles?.length) return;
    setAttachmentError("");
    try {
      const paths = Array.from(selectedFiles).map((file) =>
        settingsBridge.pathForFile(file),
      );
      const selected = await settingsBridge.readFiles(paths);
      setFiles((current) => [...current, ...selected].slice(0, 5));
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function browseWorkspace(): Promise<void> {
    if (!settingsBridge) return;
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
      void onSend({ text: `/${command.name}`, images: [], files: [] });
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    setValue(`/${command.name}${command.hint ? " " : ""}`);
    setCommandIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function selectConfig(configId: string, selectedValue: string): void {
    onConfigChange(configId, selectedValue);
    setConfigMenu(null);
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
                onClick={() =>
                  setImages((current) =>
                    current.filter((item) => item.id !== image.id),
                  )
                }
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
                onClick={() =>
                  setFiles((current) =>
                    current.filter((item) => item.id !== file.id),
                  )
                }
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
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
        placeholder="무엇이든 요청하세요"
        rows={1}
        value={value}
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
            disabled={images.length >= 6}
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
              <button
                type="button"
                disabled={running}
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
              </button>
              {configMenu === modelOption.id && (
                <span className="config-option-menu config-option-menu--model">
                  <header>
                    <strong>모델 프로필</strong>
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
              title={running ? "이어서 보내기" : "메시지 보내기"}
            >
              <ArrowUp size={18} />
            </button>
          ) : (
            <button
              className="send-button send-button--stop"
              type="button"
              disabled={!running}
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
