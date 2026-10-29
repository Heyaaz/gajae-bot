import type { AgentCommand, AgentConfigOption, AgentConfigOptionValue, AgentEvent, AgentSession, ChatMessage, PlanActivity, ThoughtActivity, ToolActivity, TranscriptItem } from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";
import { GjcSdkCli, SdkCliError } from "./gjc-sdk-cli.js";
import {
  agentCommands,
  artifactReferences,
  inferToolName,
  LIVE_TOOL_STATUSES,
  markUpdated,
  nowLabel,
  PendingPermission,
  readableSessionTitle,
  receiptSubagentStatus,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  TAIL_WINDOW_MS,
  tailReadPause,
  tailRetryPause,
  taskStatus,
  taskSubagents,
  textFromContent,
  toolDiffText,
  toolImageRefs,
  toolResultText,
  toolStatus,
} from "./gjc-sdk-foundation.js";
import { fullToolText } from "./gjc-sdk-commands.js";
import { sendMessage } from "./gjc-sdk-control.js";
import {
  markTranscriptRowDirty,
  noteTranscriptEpoch,
  readPersistedTranscript,
  refreshTranscriptFromFile,
  rememberLiveRunningTranscriptSize,
  resolveToolImages,
} from "./gjc-sdk-transcript-store.js";
import { clearRunningLatches, discoveredRunState, recordLiveEvidence } from "./gjc-sdk-run-state.js";
import { persistArtifact } from "./gjc-sdk-files.js";
import {
  captureSessionState,
  patchSessionRuntime,
  refreshModelCapabilities,
  refreshSessionConfigOptions,
} from "./gjc-sdk-session-config.js";
import { clearTodoPoll, readTodoRecords, requestProgressRefresh } from "./gjc-sdk-goal-todo.js";
import { refreshSdkCommands } from "./gjc-sdk-command-palette.js";
import { projectWorkflowGate, refreshWorkflowQuestions, settleOpenQuestions } from "./gjc-sdk-questions.js";
import path from "node:path";

/** The id of the newest transcript row a tail read returned. */
export function lastTailTranscriptId(
  items: ReadonlyArray<{ kind: string; payload: unknown }>,
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== "transcript") continue;
    const id = (item.payload as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/** The controller members the live tail and session update projection read and write. */
export interface StreamHost {
  readonly disposed: boolean;
  readonly tailReads: Map<string, Promise<void>>;
  readonly attachedSessions: Set<string>;
  readonly tailControllers: Map<string, AbortController>;
  clearTodoPoll(sessionId: string): void;
  readonly toolObservers: Map<string, AbortController>;
  readonly toolSnapshots: Map<string, Map<string, ToolActivity>>;
  readonly tailCheckpoints: Map<string, { cursor: string; afterTranscriptId: string }>;
  readonly tailEventPositions: Map<string, { generation: number; seq: number }>;
  refreshWorkflowQuestions(sessionId: string): Promise<void>;
  requireCli(): Promise<GjcSdkCli>;
  projectToolStream(sessionId: string, kind: string, payload: Record<string, unknown>): void;
  repoFor(sessionId: string): string;
  projectMessageChunk(
    sessionId: string,
    role: ChatMessage["role"],
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "user_message_chunk" | "agent_message_chunk" }
    >,
  ): void;
  finalizeAssistantMessage(sessionId: string): void;
  refreshTranscriptFromFile(sessionId: string): Promise<void>;
  readonly transcripts: Map<string, TranscriptItem[]>;
  noteTranscriptEpoch(sessionId: string): void;
  readonly emitEvent: (event: AgentEvent) => void;
  appendTranscript(item: TranscriptItem): void;
  projectWorkflowGate(
    sessionId: string,
    payload: Record<string, unknown>,
  ): void;
  requestProgressRefresh(sessionId: string): void;
  upsertTool(
    sessionId: string,
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "tool_call" | "tool_call_update" }
    >,
  ): void;
  settleOpenQuestions(
    sessionId: string,
    status: "cancelled" | "timeout",
  ): void;
  handleSessionUpdate(notification: SessionNotification): void;
  updateSessionStatus(
    sessionId: string,
    status: AgentSession["status"],
    options?: { announce?: boolean },
  ): void;
  readonly generation: number;
  currentRunRevision(sessionId: string): number;
  discoveredRunState(
    sessionId: string,
  ): Promise<AgentSession["status"] | undefined>;
  refreshSdkCommands(
    sessionId: string,
    advertised?: AgentCommand[],
  ): Promise<void>;
  captureSessionState(
    sessionId: string,
    options: SessionConfigOption[],
    mode?: string | null,
  ): void;
  readonly sessionConfig: Map<string, AgentConfigOption[]>;
  readonly modelProfiles: Map<string, AgentConfigOptionValue[]>;
  refreshSessionConfigOptions(sessionId: string): Promise<void>;
  refreshModelCapabilities(sessionId: string): Promise<void>;
  patchSessionRuntime(
    sessionId: string,
    patch: Partial<
      Pick<
        AgentSession,
        | "phase"
        | "status"
        | "mode"
        | "model"
        | "modelDisplay"
        | "thinking"
        | "serviceTier"
        | "usagePercent"
        | "usagePending"
      >
    >,
  ): void;
  readonly contextUsageObservedAt: Map<string, number>;
  readonly activeThoughts: Map<string, string>;
  nextLocalId: number;
  readonly sessionPlans: Map<string, PlanActivity>;
  markTranscriptRowDirty(sessionId: string, rowId: string): void;
  readonly toolRowIndices: Map<string, Map<string, number>>;
  readonly locallyAbortedSessions: Set<string>;
  persistArtifact(
    sessionId: string,
    artifactId: string,
    value: unknown,
  ): Promise<void>;
  readTodoRecords(
    sessionId: string,
  ): Promise<unknown[] | undefined>;
  resolveToolImages(items: TranscriptItem[]): Promise<void>;
  emitActivity(
    sessionId: string,
    category: Extract<AgentEvent, { type: "session.activity" }>["category"],
  ): void;
  readonly pendingPermissions: Map<string, PendingPermission>;
  readonly sessions: Map<string, AgentSession>;
  readonly sessionMetadata: SessionMetadataStore | undefined;
  readonly compactionRecordWatermark: Map<string, number>;
  readonly compactingSessions: Set<string>;
  readonly compactionStartedAt: Map<string, number>;
  readonly compactionRecordBaseline: Map<string, number>;
  readonly cancellationWatermarks: Map<string, number>;
  recordLiveEvidence(sessionId: string): void;
  advanceRunRevision(sessionId: string): number;
  readonly workingPhaseSessions: Set<string>;
  readonly runtimeIdleSessions: Set<string>;
  readPersistedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[] | undefined>;
  readonly liveRunningSessions: Set<string>;
  rememberLiveRunningTranscriptSize(
    sessionId: string,
  ): Promise<void>;
  readonly activePromptSessions: Set<string>;
  readonly transcriptRunningSessions: Set<string>;
  readonly pendingAsyncWorkSessions: Map<string, string[]>;
  clearRunningLatches(sessionId: string): void;
  readonly cancellingSessions: Set<string>;
}

/**
 * Starts the bounded `sdk session tail --all-events` catch-up loop.
 *
 * In gjc/0.18.11 tail is a batch command, not NDJSON: it returns one JSON envelope
 * when an observed turn becomes idle or the wait window elapses, and an elapsed
 * window reports `terminal:false` with the frames it had collected. The session-file
 * watcher stays the durable transcript account; this loop is supplemental
 * lifecycle evidence. Each invocation is short-lived, resumes from the last
 * checkpoint claim, and is abortable so detach, close, delete, and app shutdown
 * cannot leak a `gjc` reader process.
 */
export function startTailFollower(host: StreamHost, sessionId: string): void {
  if (
    host.disposed ||
    host.tailReads.has(sessionId) ||
    !host.attachedSessions.has(sessionId)
  )
    return;
  const abortController = new AbortController();
  host.tailControllers.set(sessionId, abortController);
  const follow = followSessionTail(host, sessionId, abortController).finally(
    () => {
      if (host.tailReads.get(sessionId) === follow)
        host.tailReads.delete(sessionId);
      if (host.tailControllers.get(sessionId) === abortController)
        host.tailControllers.delete(sessionId);
    },
  );
  host.tailReads.set(sessionId, follow);
  void follow.catch(() => undefined);
  host.clearTodoPoll(sessionId);
  startToolObserver(host, sessionId);
}

export function stopTailFollower(host: StreamHost, sessionId: string): void {
  host.toolObservers.get(sessionId)?.abort();
  host.toolObservers.delete(sessionId);
  host.toolSnapshots.delete(sessionId);
  host.tailControllers.get(sessionId)?.abort();
  host.tailControllers.delete(sessionId);
  // Ownership of the slot ends synchronously. The old promise's `finally`
  // checks identity before cleanup, so it cannot remove a replacement follower.
  host.tailReads.delete(sessionId);
  host.tailCheckpoints.delete(sessionId);
  host.tailEventPositions.delete(sessionId);
}

export function startToolObserver(host: StreamHost, sessionId: string): void {
  if (host.toolObservers.has(sessionId) || host.disposed) return;
  const controller = new AbortController();
  host.toolObservers.set(sessionId, controller);
  void host.refreshWorkflowQuestions(sessionId);
  const detached = new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  void (async () => {
    while (!host.disposed && !controller.signal.aborted && host.attachedSessions.has(sessionId)) {
      try {
        const cli = await host.requireCli();
        if (controller.signal.aborted) return;
        await cli.observeTools(sessionId, (kind, payload) => {
          if (!controller.signal.aborted && !host.disposed)
            host.projectToolStream(sessionId, kind, payload);
        }, controller.signal, host.repoFor(sessionId));
      } catch {
        // The observer has no lifecycle authority. Durable tail/file reads still
        // work during relay failure, and a fresh connection accepts snapshots.
      }
      if (!controller.signal.aborted) await tailReadPause(detached);
    }
  })().finally(() => {
    if (host.toolObservers.get(sessionId) === controller) host.toolObservers.delete(sessionId);
  });
}

export function projectToolStream(host: StreamHost, sessionId: string, kind: string, payload: Record<string, unknown>): void {
  if (kind === "message_update" || kind === "message_end") {
    const event = payload.event as Record<string, unknown> | undefined;
    const message = event?.message as Record<string, unknown> | undefined;
    if (event?.type !== kind || message?.role !== "assistant" || !Array.isArray(message.content)) return;
    const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (kind === "message_update") {
      if (delta?.type === "thinking_delta" && typeof delta.delta === "string")
        projectThoughtChunk(host, sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta.delta } });
      if (delta?.type === "text_delta" && typeof delta.delta === "string") {
        finalizeThought(host, sessionId);
        host.projectMessageChunk(sessionId, "assistant", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta.delta } });
      }
    } else {
      finalizeThought(host, sessionId);
      host.finalizeAssistantMessage(sessionId);
      void host.refreshTranscriptFromFile(sessionId);
    }
    return;
  }
  // The installed SDK publishes reply snapshots as turn_stream, not ACP
  // agent_message_chunk. They are cumulative text, never append-only deltas.
  if (kind === "turn_stream") {
    if (payload.sessionId !== sessionId || typeof payload.text !== "string" ||
      typeof payload.messageRef !== "string" ||
      (payload.phase !== "live" && payload.phase !== "finalized")) return;
    // A finalized snapshot can arrive after the durable watcher has already
    // published this reply. It is not a second assistant message.
    const recorded = [...(host.transcripts.get(sessionId) ?? [])].reverse().find((item) =>
      item.kind === "message" && item.role === "assistant" &&
      item.content === payload.text &&
      (item.id.startsWith("shared-message-") || item.id.startsWith("gjc-message-")),
    );
    const id = recorded?.id ?? `gjc-message-stream-${payload.messageRef}`;
    const existing = host.transcripts.get(sessionId)?.find((item) => item.id === id);
    if (existing?.kind === "message" && existing.streaming === false && payload.phase === "live") return;
    const message: ChatMessage = {
      id, kind: "message", sessionId, role: "assistant", content: payload.text,
      createdAt: existing?.createdAt ?? nowLabel(), streaming: payload.phase === "live",
    };
    if (existing?.kind === "message") {
      Object.assign(existing, message);
      host.noteTranscriptEpoch(sessionId);
      host.emitEvent({ type: "message.updated", message: { ...message } });
    } else host.appendTranscript(message);
    return;
  }
  if (kind === "workflow_gate") {
    host.projectWorkflowGate(sessionId, payload);
    host.requestProgressRefresh(sessionId);
    return;
  }
  const event = payload.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const value = event as Record<string, unknown>;
  if (value.type !== kind || typeof value.toolCallId !== "string" || typeof value.toolName !== "string") return;
  if (!["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(kind)) return;
  const existing = host.transcripts.get(sessionId)?.find((item) => item.kind === "tool" && item.id === value.toolCallId);
  if (existing?.kind === "tool" && !LIVE_TOOL_STATUSES.has(existing.status)) return;
  const ended = kind === "tool_execution_end";
  if (ended) host.requestProgressRefresh(sessionId);
  const result = ended ? value.result : value.partialResult;
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown> : undefined;
  const text = record ? toolResultText(record) ?? "" : undefined;
  host.upsertTool(sessionId, {
    sessionUpdate: kind === "tool_execution_start" ? "tool_call" : "tool_call_update",
    toolCallId: value.toolCallId,
    title: value.toolName,
    rawInput: value.args,
    status: ended ? value.isError === true ? "failed" : "completed" : "in_progress",
    ...(record ? {
      rawOutput: !ended && value.toolName === "bash"
        ? `[실시간 출력 스냅샷 · 앞부분이 생략될 수 있음]\n${text}` : text,
      content: Array.isArray(record.content) ? record.content : undefined,
    } : {}),
  });
  const tool = host.transcripts.get(sessionId)?.find((item): item is ToolActivity => item.kind === "tool" && item.id === value.toolCallId);
  if (!tool) return;
  let snapshots = host.toolSnapshots.get(sessionId);
  if (!snapshots) host.toolSnapshots.set(sessionId, snapshots = new Map());
  snapshots.set(tool.id, { ...tool });
  if (snapshots.size > 256) snapshots.delete(snapshots.keys().next().value!);
  if (
    ended &&
    value.isError === true &&
    value.toolName === "ask" &&
    (text ?? "").includes("gjc.ask.timeout")
  )
    host.settleOpenQuestions(sessionId, "timeout");
}

async function followSessionTail(
  host: StreamHost,
  sessionId: string,
  controller: AbortController,
): Promise<void> {
  const detached = new Promise<void>((resolve) => {
    if (controller.signal.aborted) resolve();
    else
      controller.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
  });
  let transientFailures = 0;
  while (
    !host.disposed &&
    !controller.signal.aborted &&
    host.attachedSessions.has(sessionId)
  ) {
    try {
      const cli = await host.requireCli();
      const tail = await cli.tail(sessionId, {
        repo: host.repoFor(sessionId),
        ...host.tailCheckpoints.get(sessionId),
        untilIdle: true,
        timeoutMs: TAIL_WINDOW_MS,
        signal: controller.signal,
      });
      transientFailures = 0;
      if (tail.gap) {
        host.tailCheckpoints.delete(sessionId);
        await host.refreshTranscriptFromFile(sessionId);
        await tailReadPause(detached);
        continue;
      }
      // A read with no new transcript row resumes at the row the last one ended at.
      const afterTranscriptId =
        lastTailTranscriptId(tail.items) ??
        host.tailCheckpoints.get(sessionId)?.afterTranscriptId;
      if (tail.checkpointToken && afterTranscriptId)
        host.tailCheckpoints.set(sessionId, {
          cursor: tail.checkpointToken,
          afterTranscriptId,
        });
      else host.tailCheckpoints.delete(sessionId);
      projectTailItems(host, sessionId, tail.items);
      if (tail.source === "offline") return;
      // Pace every read, including one that returned frames. An active stream
      // returns as soon as it has data, so pausing only on an empty answer tied
      // process spawns to the frame rate: a live turn re-launched a ~400MB tail
      // reader more than once a second. The file watcher already delivers rows;
      // one window between reads is the cost of keeping stream events ordered.
      await tailReadPause(detached);
    } catch (error) {
      if (controller.signal.aborted || host.disposed) return;
      if (error instanceof SdkCliError) {
        if (error.code === "aborted") return;
        // A timeout means only that no terminal turn event arrived inside this
        // bounded window. It is not a failed run and never clears the spinner.
        if (error.code === "tail_timeout") {
          await tailReadPause(detached);
          continue;
        }
        // A checkpoint the reader refuses -- one without its transcript boundary,
        // or one past its expiry -- is refused on every retry. Keeping it is what
        // left a session with no live follower at all: each pass failed with
        // `usage`, and only the file watcher still reported the turn.
        if (
          error.code === "retention_gap" ||
          (error.code === "usage" && host.tailCheckpoints.has(sessionId))
        ) {
          host.tailCheckpoints.delete(sessionId);
          await host.refreshTranscriptFromFile(sessionId);
          await tailReadPause(detached);
          continue;
        }
        if (
          error.code === "session_deleted" ||
          error.code === "session_unavailable"
        )
          return;
      }
      // The session is still attached, so a transport failure is not a reason to
      // stop following it forever. Retry with a capped backoff, preserving the
      // checkpoint, instead of leaving the early-returning attach path with no
      // follower and no way to notice.
      transientFailures += 1;
      await tailRetryPause(detached, transientFailures);
      continue;
    }
  }
}

export function projectTailItems(
  host: StreamHost,
  sessionId: string,
  items: Array<{
    kind: string;
    payload: unknown;
    generation?: number;
    seq?: number;
  }>,
): void {
  let transcriptEvidence = false;
  // Compare every frame in this response to the prior response's watermark.
  // Advancing it frame-by-frame would mistake later frames in an initial
  // catch-up batch for fresh work merely because an earlier frame seeded it.
  const priorPosition = host.tailEventPositions.get(sessionId);
  let newestPosition = priorPosition;
  for (const item of items) {
    const payload =
      item.payload &&
      typeof item.payload === "object" &&
      !Array.isArray(item.payload)
        ? (item.payload as Record<string, unknown>)
        : undefined;
    const directUpdate = payload?.sessionUpdate;
    const nested =
      payload?.update &&
      typeof payload.update === "object" &&
      !Array.isArray(payload.update)
        ? (payload.update as Record<string, unknown>)
        : undefined;
    const positioned =
      typeof item.generation === "number" && typeof item.seq === "number";
    const isNewTailEvent =
      positioned &&
      priorPosition !== undefined &&
      (item.generation! > priorPosition.generation ||
        (item.generation === priorPosition.generation &&
          item.seq! > priorPosition.seq));
    const projectUpdate = (source: Record<string, unknown>) => {
      if (typeof source.sessionUpdate !== "string") return;
      let update = source;
      if (!isNewTailEvent) {
        const meta = source._meta;
        if (meta && typeof meta === "object" && !Array.isArray(meta)) {
          const otherMeta = { ...(meta as Record<string, unknown>) };
          delete otherMeta.gjcRunning;
          delete otherMeta.gjcPhase;
          delete otherMeta.gjcCompactionState;
          update = { ...source, _meta: otherMeta };
        }
      }
      host.handleSessionUpdate({
        sessionId,
        update: update as unknown as SessionUpdate,
      });
    };
    if (typeof directUpdate === "string") projectUpdate(payload!);
    else if (typeof nested?.sessionUpdate === "string") projectUpdate(nested);
    if (item.kind === "transcript") transcriptEvidence = true;
    if (
      positioned &&
      (!newestPosition || item.generation! > newestPosition.generation ||
        (item.generation === newestPosition.generation &&
          item.seq! > newestPosition.seq))
    )
      newestPosition = { generation: item.generation!, seq: item.seq! };
    // The first tail read is a catch-up snapshot: its start events may describe
    // already-finished work. Only a start beyond a sequence position we've
    // observed before this frame (including a newer generation) can reopen an
    // idle session. Missing sequence metadata is insufficient evidence.
    if (
      (item.kind === "turn_start" || item.kind === "agent_start") &&
      isNewTailEvent
    )
      host.updateSessionStatus(sessionId, "running");
    if (item.kind === "agent_failed" && isNewTailEvent)
      host.updateSessionStatus(sessionId, "failed", { announce: false });
    if (
      isNewTailEvent &&
      (item.kind === "turn_end" || item.kind === "agent_end")
    ) {
      void reconcileTailTerminalState(host, sessionId);
      host.requestProgressRefresh(sessionId);
    }
    if (item.kind === "session_closed" || item.kind === "session_terminated")
      stopTailFollower(host, sessionId);
  }
  if (newestPosition) host.tailEventPositions.set(sessionId, newestPosition);
  if (transcriptEvidence) void host.refreshTranscriptFromFile(sessionId);
}

export async function reconcileTailTerminalState(host: StreamHost, sessionId: string): Promise<void> {
  const generation = host.generation;
  const revision = host.currentRunRevision(sessionId);
  const state = await host.discoveredRunState(sessionId);
  if (state !== undefined && state !== "running" && generation === host.generation && revision === host.currentRunRevision(sessionId))
    host.updateSessionStatus(sessionId, state);
}

/**
 * Projects one session update into the transcript.
 *
 * These come from `gjc sdk session tail` frames and from rows read
 * out of the session file, both of which carry the same shapes. Keeping this
 * switch as the single projection point is what lets the renderer stay unchanged.
 */
export function handleSessionUpdate(host: StreamHost, notification: SessionNotification): void {
  const { sessionId, update } = notification;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      host.projectMessageChunk(sessionId, "user", update);
      break;
    case "agent_message_chunk":
      finalizeThought(host, sessionId);
      host.projectMessageChunk(sessionId, "assistant", update);
      break;
    case "agent_thought_chunk":
      projectThoughtChunk(host, sessionId, update);
      break;
    case "tool_call":
      finalizeThought(host, sessionId);
      host.upsertTool(sessionId, update);
      break;
    case "tool_call_update":
      host.upsertTool(sessionId, update);
      break;
    case "session_info_update":
      patchSessionInfo(host, sessionId, update);
      break;
    case "plan":
      upsertPlan(host, sessionId, update.entries);
      break;
    case "available_commands_update": {
      // GJC's own command list for this session. An empty update is authoritative
      // too -- it says the session has no dynamic commands, so the synthesized
      // skill entries must not be merged back over it.
      void host.refreshSdkCommands(
        sessionId,
        agentCommands(update.availableCommands),
      );
      break;
    }
    case "config_option_update": {
      host.captureSessionState(sessionId, update.configOptions);
      if (host.attachedSessions.has(sessionId)) {
        const selected = host.sessionConfig
          .get(sessionId)
          ?.find(
            (option) => option.category === "model" || option.id === "model",
          )?.currentValue;
        const known =
          typeof selected === "string" &&
          (host.modelProfiles.get(sessionId) ?? []).some(
            (profile) => profile.value === selected,
          );
        // A selection already in the cached catalog needs only its display and
        // thinking details. A selection outside it may be a profile added since
        // the last read, so that one still re-lists the catalog.
        if (typeof selected === "string" && !known)
          void host.refreshSessionConfigOptions(sessionId);
        else void host.refreshModelCapabilities(sessionId);
      }
      break;
    }
    case "current_mode_update":
      host.patchSessionRuntime(sessionId, { mode: update.currentModeId });
      break;
    case "usage_update":
      host.contextUsageObservedAt.set(sessionId, Date.now());
      if (update.size > 0)
        host.patchSessionRuntime(sessionId, {
          usagePercent: Math.min(
            100,
            Math.max(0, (update.used / update.size) * 100),
          ),
          usagePending: false,
        });
      break;
    default:
      break;
  }
}

export function projectThoughtChunk(
  host: StreamHost,
  sessionId: string,
  update: Extract<SessionUpdate, { sessionUpdate: "agent_thought_chunk" }>,
): void {
  const text = textFromContent(update.content);
  if (!text) return;
  const existingId = host.activeThoughts.get(sessionId);
  if (existingId) {
    const thought = (host.transcripts.get(sessionId) ?? []).find(
      (item): item is ThoughtActivity =>
        item.kind === "thought" && item.id === existingId,
    );
    if (!thought) return;
    thought.content += text;
    host.noteTranscriptEpoch(sessionId);
    host.emitEvent({
      type: "thought.delta",
      sessionId,
      thoughtId: thought.id,
      delta: text,
      streaming: true,
    });
    return;
  }
  const thought: ThoughtActivity = {
    id: update.messageId
      ? `gjc-thought-${update.messageId}`
      : `gjc-thought-${host.nextLocalId++}`,
    kind: "thought",
    sessionId,
    content: text,
    createdAt: nowLabel(),
    streaming: true,
  };
  host.activeThoughts.set(sessionId, thought.id);
  host.appendTranscript(thought);
}

export function finalizeThought(host: StreamHost, sessionId: string): void {
  const thoughtId = host.activeThoughts.get(sessionId);
  if (!thoughtId) return;
  const thought = (host.transcripts.get(sessionId) ?? []).find(
    (item): item is ThoughtActivity =>
      item.kind === "thought" && item.id === thoughtId,
  );
  if (thought) {
    thought.streaming = false;
    host.noteTranscriptEpoch(sessionId);
    host.emitEvent({
      type: "thought.delta",
      sessionId,
      thoughtId,
      delta: "",
      streaming: false,
    });
  }
  host.activeThoughts.delete(sessionId);
}

function upsertPlan(
  host: StreamHost,
  sessionId: string,
  entries: Extract<SessionUpdate, { sessionUpdate: "plan" }>["entries"],
): void {
  const items = host.transcripts.get(sessionId) ?? [];
  const existing = items.find(
    (item): item is PlanActivity => item.kind === "plan",
  );
  const plan: PlanActivity = {
    id: existing?.id ?? `gjc-plan-${host.nextLocalId++}`,
    kind: "plan",
    sessionId,
    entries: entries.map((entry) => ({
      content: entry.content,
      status:
        entry.status === "in_progress" || entry.status === "completed"
          ? entry.status
          : "pending",
    })),
    createdAt: existing?.createdAt ?? nowLabel(),
  };
  if (existing) {
    Object.assign(existing, plan);
    host.noteTranscriptEpoch(sessionId);
  } else host.appendTranscript(plan);
  // The row the session actually carries is the retained one, so a later durable
  // rebuild composes the same plan state instead of an earlier copy of it. An
  // update with no entries is still an update: it clears them.
  host.sessionPlans.set(sessionId, existing ?? plan);
  host.markTranscriptRowDirty(sessionId, plan.id);
  host.emitEvent({
    type: "plan.updated",
    plan: { ...plan, entries: plan.entries.map((entry) => ({ ...entry })) },
  });
}

export function upsertTool(
  host: StreamHost,
  sessionId: string,
  update: Extract<
    SessionUpdate,
    { sessionUpdate: "tool_call" | "tool_call_update" }
  >,
): void {
  host.markTranscriptRowDirty(sessionId, update.toolCallId);
  const items = host.transcripts.get(sessionId) ?? [];
  let indices = host.toolRowIndices.get(sessionId);
  if (!indices) {
    indices = new Map();
    host.toolRowIndices.set(sessionId, indices);
  }
  let existingIndex = indices.get(update.toolCallId);
  const indexed =
    existingIndex === undefined ? undefined : items[existingIndex];
  let existing: ToolActivity | undefined =
    indexed?.kind === "tool" && indexed.id === update.toolCallId
      ? indexed
      : undefined;
  if (!existing) {
    existingIndex = items.findIndex(
      (item): item is ToolActivity =>
        item.kind === "tool" && item.id === update.toolCallId,
    );
    const found = existingIndex >= 0 ? items[existingIndex] : undefined;
    existing = found?.kind === "tool" ? found : undefined;
    if (existingIndex >= 0) indices.set(update.toolCallId, existingIndex);
    else indices.delete(update.toolCallId);
  }
  if (
    host.locallyAbortedSessions.has(sessionId) &&
    update.sessionUpdate === "tool_call" &&
    !existing
  )
    return;
  if (update.sessionUpdate === "tool_call" && !existing)
    host.finalizeAssistantMessage(sessionId);
  const name = inferToolName(update, existing);
  const input =
    update.rawInput &&
    typeof update.rawInput === "object" &&
    !Array.isArray(update.rawInput)
      ? (update.rawInput as Record<string, unknown>)
      : undefined;
  const diff =
    toolDiffText(update.rawOutput, update.content) ?? existing?.diff;
  const images = [
    ...toolImageRefs(update.content),
    ...toolImageRefs(update.rawOutput),
  ];
  const projectedStatus = update.status
    ? toolStatus(update.status)
    : (existing?.status ?? "running");
  const rawOutput = update.rawOutput ?? update.content;
  const outputText = fullToolText(rawOutput);
  const subagents =
    name === "task"
      ? input
        ? taskSubagents(input, projectedStatus, outputText)
        : existing?.subagents?.map((agent) => ({
            ...agent,
            status:
              receiptSubagentStatus(outputText, agent.id) ??
              taskStatus(projectedStatus),
          }))
      : undefined;
  const patch: ToolActivity = {
    id: update.toolCallId,
    kind: "tool",
    sessionId,
    name,
    description: update.title ?? existing?.description ?? name,
    command: fullToolText(update.rawInput) ?? existing?.command,
    status: projectedStatus,
    createdAt: existing?.createdAt ?? nowLabel(),
    output: fullToolText(update.rawOutput ?? update.content) ?? existing?.output,
    artifactRefs: [
      ...new Set([
        ...(existing?.artifactRefs ?? []),
        ...artifactReferences(update.rawInput),
        ...artifactReferences(update.rawOutput ?? update.content),
      ]),
    ],
    ...(diff ? { diff } : {}),
    ...(typeof input?.path === "string" && input.path
      ? { targetPath: input.path }
      : existing?.targetPath
        ? { targetPath: existing.targetPath }
        : {}),
    ...(images.length > 0
      ? { images }
      : existing?.images
        ? { images: existing.images }
        : {}),
    ...(subagents && subagents.length > 0 ? { subagents } : {}),
  };
  if (update.rawInput !== undefined) {
    const id = `${sessionId}-${update.toolCallId}-input`.replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    patch.inputArtifactId = id;
    void host.persistArtifact(sessionId, id, update.rawInput).catch((error) =>
      console.error(`Failed to persist tool input artifact ${id}`, error),
    );
  }
  if (update.rawOutput !== undefined || update.content !== undefined) {
    const id = `${sessionId}-${update.toolCallId}-output`.replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    patch.outputArtifactId = id;
    void host.persistArtifact(
      sessionId,
      id,
      update.rawOutput ?? update.content,
    ).catch((error) =>
      console.error(`Failed to persist tool output artifact ${id}`, error),
    );
  }
  if (existing) {
    Object.assign(existing, patch);
    host.noteTranscriptEpoch(sessionId);
    host.emitEvent({ type: "tool.updated", tool: { ...existing } });
  } else {
    host.appendTranscript(patch);
  }
  // A todo tool that finished is the only live signal that the store may have
  // changed, and it is not a todo record: it is a request. The store itself is
  // read back so what is shown is what the runtime recorded, not the input op.
  if (name === "todo_write" && patch.status === "completed")
    void host.readTodoRecords(sessionId);
  if (patch.images?.some((image) => image.blobId && !image.dataUrl)) {
    const settled = existing ?? patch;
    void host.resolveToolImages([settled])
      .then(() => {
        host.noteTranscriptEpoch(sessionId);
        host.emitEvent({ type: "tool.updated", tool: { ...settled } });
      })
      .catch(() => undefined);
  }
}

export function patchTool(host: StreamHost, toolId: string, patch: Partial<ToolActivity>): void {
  for (const items of host.transcripts.values()) {
    const tool = items.find(
      (item): item is ToolActivity =>
        item.kind === "tool" && item.id === toolId,
    );
    if (!tool) continue;
    const waiting =
      tool.status !== "approval-required" &&
      patch.status === "approval-required";
    Object.assign(tool, patch);
    host.noteTranscriptEpoch(tool.sessionId);
    host.emitEvent({ type: "tool.updated", tool: { ...tool } });
    if (waiting) host.emitActivity(tool.sessionId, "permission");
    return;
  }
}

/**
 * Records a tool call that is waiting on an approval decision.
 *
 * A broker-hosted session host cannot ask an external controller for a decision,
 * so nothing calls this over a live channel any more; the session's permission
 * mode is set instead (see `applyPermissionMode`). It stays because a transcript
 * row can still report a tool as awaiting approval, and the window has to show
 * that state and be able to clear it on cancel.
 */
function requestPermission(
  host: StreamHost,
  request: PendingPermission["request"],
): Promise<{ outcome: { outcome: string; optionId?: string } }> {
  const { toolCall } = request;
  host.upsertTool(request.sessionId, {
    sessionUpdate: "tool_call_update",
    ...toolCall,
    status: "pending",
  });
  patchTool(host, toolCall.toolCallId, { status: "approval-required" });
  patchTool(host, toolCall.toolCallId, {
    permissionOptions: request.options.map((option) => ({
      optionId: option.optionId,
      kind: option.kind,
      name: option.name,
    })),
  });
  return new Promise((resolve) => {
    host.pendingPermissions.set(toolCall.toolCallId, { request, resolve });
  });
}

export function patchSessionInfo(
  host: StreamHost,
  sessionId: string,
  update: Extract<SessionUpdate, { sessionUpdate: "session_info_update" }>,
): void {
  const session = host.sessions.get(sessionId);
  if (!session) return;
  if (update.title?.trim() && !host.sessionMetadata?.getAlias(sessionId)) {
    session.title = readableSessionTitle(sessionId, update.title);
  }
  if (update.updatedAt) markUpdated(session, update.updatedAt);
  const phase =
    typeof update._meta?.gjcPhase === "string"
      ? update._meta.gjcPhase
      : undefined;
  const running = update._meta?.gjcRunning;
  const compactionState =
    update._meta?.gjcCompactionState === "start" ||
    update._meta?.gjcCompactionState === "end"
      ? update._meta.gjcCompactionState
      : undefined;
  const phaseTimestamp =
    typeof update.updatedAt === "string" ? Date.parse(update.updatedAt) : NaN;
  const staleOrderedPhase =
    (phase === "compacting" || phase === "working") &&
    Number.isFinite(phaseTimestamp) &&
    (host.compactionRecordWatermark.get(sessionId) ?? -Infinity) >=
      phaseTimestamp;
  if (phase === "compacting" && !staleOrderedPhase) {
    session.phase = "compacting";
    host.compactingSessions.add(sessionId);
    if (Number.isFinite(phaseTimestamp))
      host.compactionStartedAt.set(sessionId, phaseTimestamp);
    if (!host.locallyAbortedSessions.has(sessionId))
      session.status = "running";
  } else if (phase && !staleOrderedPhase) {
    // GJC reporting any other phase is the authority that compaction ended, so
    // this is where a locally started compaction is released. Returning from the
    // control call only meant the request was accepted.
    if (
      (phase === "working" && update.updatedAt !== undefined) ||
      phase === "responding" ||
      phase === "idle"
    ) {
      host.compactingSessions.delete(sessionId);
      host.compactionRecordBaseline.delete(sessionId);
      host.compactionStartedAt.delete(sessionId);
    }
    session.phase =
      phase === "responding" || phase === "idle" ? undefined : phase;
  }
  // A report carrying `updatedAt` is describing an actual change of state; GJC's
  // explicit compaction start/end events are ordered lifecycle evidence too, even
  // though current releases omit updatedAt on those two notifications.
  const lifecycleChanged =
    update.updatedAt !== undefined || compactionState !== undefined;
  const runtimeConfirmedWorkingCycle =
    lifecycleChanged &&
    !staleOrderedPhase &&
    (running === true || (phase !== undefined && phase !== "idle"));
  if (runtimeConfirmedWorkingCycle) {
    // A new ordered runtime cycle supersedes the app's cancellation fence; the
    // fence only suppresses stale evidence from the cancelled run.
    const cancelledAt = host.cancellationWatermarks.get(sessionId);
    if (cancelledAt !== undefined && Number.isFinite(phaseTimestamp) && phaseTimestamp > cancelledAt) {
      host.locallyAbortedSessions.delete(sessionId);
      host.cancellationWatermarks.delete(sessionId);
    }
    // A non-idle phase with a timestamp is a state change the runtime just
    // reported, which is live evidence of work like any other.
    host.recordLiveEvidence(sessionId);
    host.advanceRunRevision(sessionId);
    host.workingPhaseSessions.add(sessionId);
    host.runtimeIdleSessions.delete(sessionId);
  }
  const runtimeFinishedWorkingCycle =
    lifecycleChanged &&
    (phase === "idle" || (phase === undefined && running === false)) &&
    host.workingPhaseSessions.has(sessionId);
  if (runtimeFinishedWorkingCycle) {
    host.runtimeIdleSessions.add(sessionId);
    // The transcript may already contain the final assistant row. If it does not,
    // its watcher will call this again when that row arrives.
    void host.readPersistedTranscript(sessionId);
  }
  if (
    running === true &&
    !staleOrderedPhase &&
    !host.locallyAbortedSessions.has(sessionId)
  ) {
    if (session.status !== "running" && !runtimeConfirmedWorkingCycle)
      host.advanceRunRevision(sessionId);
    // The report is the runtime asserting this session is working right now -- the
    // bootstrap pair an attach delivers is the same report -- so the aging clock
    // runs from here rather than from when the latch was first armed.
    host.recordLiveEvidence(sessionId);
    session.status = "running";
    if (!host.liveRunningSessions.has(sessionId)) {
      host.liveRunningSessions.add(sessionId);
      // Record how much transcript existed when the work was reported, so a later
      // read can tell an unchanged stale snapshot from one that watched it end.
      void host.rememberLiveRunningTranscriptSize(sessionId);
    }
  }
  if (phase === "compacting" && !staleOrderedPhase) {
    // Capture the revision only after this event has advanced it. Starting this
    // read earlier made it stale itself synchronously, so a completion record
    // already on disk could never clear the newly armed working marker.
    void host.readPersistedTranscript(sessionId).catch(() => undefined);
  }
  // A prompt this window sent owns the status until its own round trip settles,
  // because GJC reports gjcRunning:false for the state *before* the prompt was
  // accepted. Telling the two apart needs one bit of history: a stale report
  // arrives without GJC ever having confirmed the turn started, while a genuine
  // completion always follows a gjcRunning:true for that same turn. Ignoring
  // every report instead left the row running forever whenever the prompt never
  // got its reply.
  //
  // The same reasoning covers a turn nobody here started. Attaching to a session
  // makes GJC publish a bootstrap `gjcRunning:false` describing *this connection's*
  // prompt state, which says nothing about work another process is driving. Reading
  // it as a completion is what flipped a working session to 완료 the moment it was
  // clicked. Only a report that follows a confirmed start closes a turn.
  const neverConfirmedRunning = !host.liveRunningSessions.has(sessionId);
  const staleForActivePrompt =
    host.activePromptSessions.has(sessionId) && neverConfirmedRunning;
  // Which report to discard depends on where the row's running state came from. A
  // status this window set for its own command is answered by that command's own
  // live report. A status read out of the transcript belongs to work in another
  // process, and the bootstrap report carries no information about it.
  const bootstrapForForeignTurn =
    !host.activePromptSessions.has(sessionId) &&
    neverConfirmedRunning &&
    host.transcriptRunningSessions.has(sessionId);
  // Attaching delivers two reports 0.1s apart, captured from the running app:
  //   {updatedAt, _meta:{gjcPhase:"working", gjcRunning:true}}
  //   {           _meta:{gjcPhase:"idle",    gjcRunning:false}}
  // The second is the bootstrap restatement of this connection's prompt slot, and it
  // has no `updatedAt` because nothing changed. The guard below already ignored it, but
  // only while nothing had confirmed the session running -- and the report 0.1s earlier
  // had just done exactly that, so the idle won and the row read 완료 while a tool was
  // still working.
  //
  // A real runtime transition states when it happened, so requiring `updatedAt`
  // rejects the restatement. It still does not finish the row by itself: the
  // transcript must also contain the cycle's terminal assistant response.
  const bootstrapIdleAfterWorking =
    update.updatedAt === undefined &&
    host.workingPhaseSessions.has(sessionId);
  if (
    running === false &&
    session.status !== "failed" &&
    !staleForActivePrompt &&
    !bootstrapForForeignTurn &&
    !bootstrapIdleAfterWorking &&
    !host.workingPhaseSessions.has(sessionId) &&
    !host.pendingAsyncWorkSessions.has(sessionId) &&
    !host.compactingSessions.has(sessionId)
  ) {
    // A turn this window did not start -- a steer, or work driven from the
    // terminal -- ends here rather than in sendMessage, so this is where its
    // completion is announced. A cancel is excluded: the user performed it and
    // is already watching, so announcing it is noise.
    const wasRunning = session.status === "running";
    if (session.status !== "idle") host.advanceRunRevision(sessionId);
    session.status = "idle";
    host.clearRunningLatches(sessionId);
    if (session.phase === "compacting") session.phase = undefined;
    if (
      wasRunning &&
      !host.cancellingSessions.has(sessionId) &&
      !host.locallyAbortedSessions.has(sessionId)
    )
      host.emitActivity(sessionId, "completed");
  }
  if (typeof update._meta?.gjcThinkingLevel === "string")
    session.thinking = update._meta.gjcThinkingLevel;
  host.emitEvent({ type: "session.updated", session: { ...session } });
}
