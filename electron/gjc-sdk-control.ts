import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentSession, MessageDelivery, NoticeActivity, QueuedMessage, ToolActivity, TranscriptItem } from "../shared/agent-contract.js";
import { envelopeResult, freshOperationRef, GjcSdkCli, isSessionUnreachable } from "./gjc-sdk-cli.js";
import {
  attachedPathsText,
  brokerFailureMessage,
  busyPromptError,
  cancelledOperationError,
  messageTextWithFiles,
  normalizeQueuedRequestText,
  nowLabel,
  OwnedStopUnavailableError,
  PROMPT_NOT_EXECUTED_MESSAGE,
  promptPreflightNotExecutedError,
  promptPreflightNotExecutedReceipt,
  requestFailureDetail,
  ResolvedMessageInput,
  SendMessageOptions,
  SHARED_ROUTE_UNAVAILABLE_MESSAGE,
  uncertainAfterSendError,
} from "./gjc-sdk-foundation.js";
import { persistedCompactionCount } from "./gjc-sdk-transcript-store.js";
import { ensureAttached } from "./gjc-sdk-attach.js";
import { discoveredRunState, republishRunState } from "./gjc-sdk-run-state.js";
import { patchSessionRuntime, refreshContextUsage } from "./gjc-sdk-session-config.js";
import { settleOpenQuestions } from "./gjc-sdk-questions.js";
import { executeSdkSlashCommand } from "./gjc-sdk-slash-commands.js";
import path from "node:path";

/**
 * Manual compaction summarizes a whole context with the model. A 278k-token
 * session took 88 seconds on the installed runtime, so the ordinary 8-second
 * control deadline reports a false uncertainty while the host is still working.
 */
export const COMPACTION_TIMEOUT_MS = 300_000;

export const REQUEST_OUTCOME_RECONCILIATION_BUDGET_MS = 20_000;

// The session file watcher and tail already carry the visible terminal row.
// This query only reconciles the send promise's own record, so it is a backstop:
// a 400ms cadence spawned a CLI process every ~0.4s for the whole budget, which
// was the dominant cost of a long turn. One second still settles a quick turn
// promptly without tying process spawns to the polling clock.
export const REQUEST_OUTCOME_RECONCILIATION_INTERVAL_MS = 1_000;

export const REQUEST_OUTCOME_QUERY_TIMEOUT_MS = 2_000;

/** The controller members sending, steering and aborting a turn read and write. */
export interface ControlHost {
  readonly sessions: Map<string, AgentSession>;
  persistedCompactionCount(
    sessionId: string,
  ): Promise<number | undefined>;
  readonly compactingSessions: Set<string>;
  readonly compactionStartedAt: Map<string, number>;
  readonly compactionRecordBaseline: Map<string, number>;
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
  controlSession(
    sessionId: string,
    operation:
      | "turn.prompt"
      | "turn.steer"
      | "turn.follow_up"
      | "turn.abort"
      | "queue.message.remove"
      | "compaction.run"
      | "mode.goal.operate"
      | "mode.plan.set"
      | "thinking.set"
      | "thinking.cycle"
      | "model.profile.set"
      | "permission_mode.set"
      | "config.patch"
      | "service_tier.set"
      | "session.export_html"
      | "context.clear"
      | "session.rename"
      | "session.cwd.move"
      | "retry.last"
      | "bash.background"
      | "runtime.reload"
      | "auth.login"
      | "btw.ask"
      | "workflow.gate_answer",
    input: Record<string, unknown>,
    options?: { confirm?: boolean; idempotencyKey?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown> | undefined>;
  refreshContextUsage(
    sessionId: string,
    options?: { force?: boolean },
  ): Promise<void>;
  readonly echoedPromptTexts: Map<string, string[]>;
  readonly locallyAbortedSessions: Set<string>;
  appendLocalUserMessage(
    sessionId: string,
    text: string,
    input: ResolvedMessageInput,
  ): void;
  readonly pendingSteers: Map<string, Promise<MessageDelivery>>;
  ensureAttached(
    sessionId: string,
    replay: boolean,
  ): Promise<void>;
  readonly terminalOnlySessions: Set<string>;
  requireCli(): Promise<GjcSdkCli>;
  repoFor(sessionId: string): string;
  markTerminalOnly(sessionId: string): void;
  querySessionItems(
    sessionId: string,
    query: string,
    input?: Record<string, unknown>,
    options?: { strict?: boolean },
  ): Promise<unknown[]>;
  readonly flushingSessions: Set<string>;
  discoveredRunState(
    sessionId: string,
  ): Promise<AgentSession["status"] | undefined>;
  updateSessionStatus(
    sessionId: string,
    status: AgentSession["status"],
    options?: { announce?: boolean },
  ): void;
  executeSdkSlashCommand(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: SendMessageOptions,
  ): Promise<boolean>;
  readonly activePromptSessions: Set<string>;
  readonly generation: number;
  readonly activePromptAdmissions: Map<string, symbol>;
  currentRunRevision(sessionId: string): number;
  readonly activeAssistantMessages: Map<string, string>;
  finalizeThought(sessionId: string): void;
  awaitPromptSettlement(
    sessionId: string,
    operationRef: string,
    isCurrent?: () => boolean,
  ): Promise<
    | "terminal"
    | "unknown"
    | { kind: "not_executed"; detail: string }
  >;
  finalizeAssistantMessage(sessionId: string): void;
  nextLocalId: number;
  appendTranscript(item: TranscriptItem): void;
  emitActivity(
    sessionId: string,
    category: Extract<AgentEvent, { type: "session.activity" }>["category"],
  ): void;
  readonly disposed: boolean;
  republishRunState(sessionId: string): Promise<void>;
  readonly cancellationWatermarks: Map<string, number>;
  readonly cancellationPromises: Map<string, Promise<void>>;
  readonly cancellingSessions: Set<string>;
  fireAbort(
    sessionId: string,
  ): Promise<"owned" | "plain" | "no_active_turn">;
  finalizeAllMessages(sessionId: string): void;
  readonly toolSnapshots: Map<string, Map<string, ToolActivity>>;
  cancelOpenTools(sessionId: string): void;
  settleOpenQuestions(
    sessionId: string,
    status: "cancelled" | "timeout",
  ): void;
  cancelPermissionsForSession(sessionId: string): void;
  readonly liveRunningSessions: Set<string>;
  readonly liveRunningDigests: Map<string, number>;
  readonly liveEvidenceAt: Map<string, number>;
  readonly transcriptRunningSessions: Set<string>;
  readonly workingPhaseSessions: Set<string>;
  readonly runtimeIdleSessions: Set<string>;
  readonly pendingAsyncWorkSessions: Map<string, string[]>;
  readonly discoveredRunStates: Map<string, { size: number; status: AgentSession["status"]; runningJobIds?: string[] }>;
  readonly transcripts: Map<string, TranscriptItem[]>;
}

export async function compactSession(host: ControlHost, sessionId: string): Promise<void> {
  // Compaction is a session control operation. Terminal-owned sessions route
  // through the broker instead of requiring a second runtime attachment.
  const statusBefore = host.sessions.get(sessionId)?.status;
  const baseline = await host.persistedCompactionCount(sessionId);
  host.compactingSessions.add(sessionId);
  host.compactionStartedAt.delete(sessionId);
  if (baseline === undefined)
    host.compactionRecordBaseline.delete(sessionId);
  else host.compactionRecordBaseline.set(sessionId, baseline);
  host.patchSessionRuntime(sessionId, {
    phase: "compacting",
    status: "running",
  });
  try {
    await host.controlSession(sessionId, "compaction.run", {}, {
      timeoutMs: COMPACTION_TIMEOUT_MS,
    });
    // GJC intentionally reports null usage after compaction until a later model
    // response provides a trustworthy provider anchor. Never leave the stale
    // pre-compaction percentage visible while that new value is pending.
    host.patchSessionRuntime(sessionId, {
      usagePercent: undefined,
      usagePending: true,
    });
    await host.refreshContextUsage(sessionId, { force: true });
  } catch (error) {
    if (uncertainAfterSendError(error)) {
      // The host accepted the request and is still summarizing. Keep the
      // compaction markers so the durable receipt can settle the phase; clearing
      // them here left the session running forever even though the record landed.
      host.patchSessionRuntime(sessionId, {
        usagePercent: undefined,
        usagePending: true,
      });
      return;
    }
    // Compaction marked the row running. Leaving it there after a failure keeps
    // the composer queueing behind a turn that never started, so the status it
    // replaced is restored -- and only that one, or a real turn running
    // underneath would be reported idle.
    host.compactingSessions.delete(sessionId);
    host.compactionRecordBaseline.delete(sessionId);
    host.compactionStartedAt.delete(sessionId);
    host.patchSessionRuntime(sessionId, {
      phase: undefined,
      ...(statusBefore && statusBefore !== "running"
        ? { status: statusBefore }
        : {}),
    });
    throw error;
  }
  // The control call returning means GJC accepted the request, not that the
  // history has been rewritten. Clearing the phase here reported compaction
  // finished while it was still running, so the phase is left standing until
  // GJC reports a non-compacting phase through patchSessionInfo.
}

// Returns true when this user update is GJC repeating a prompt already shown.
export function consumePromptEcho(host: ControlHost, sessionId: string, text: string): boolean {
  const echoes = host.echoedPromptTexts.get(sessionId);
  if (!echoes?.length) return false;
  const normalized = normalizeQueuedRequestText(text);
  const index = echoes.indexOf(normalized);
  if (index < 0) return false;
  echoes.splice(index, 1);
  if (echoes.length === 0) host.echoedPromptTexts.delete(sessionId);
  return true;
}

export async function steerSession(
  host: ControlHost,
  sessionId: string,
  input: ResolvedMessageInput,
  options?: { echo?: boolean },
): Promise<MessageDelivery> {
  host.locallyAbortedSessions.delete(sessionId);
  const text = messageTextWithFiles(input)
    .replace(/^\/steer(?:\s+|$)/u, "")
    .trim();
  if (!text) throw new Error("Steering instructions are required");
  // A steer is a user message too. Echoing it before the round trip is what
  // makes it appear immediately; without this the bubble waits for GJC to
  // stream its own user_message_chunk back, which is seconds late on a busy
  // turn and reads as the window having swallowed the message. Callers that
  // already echoed the same text pass echo: false so it is not shown twice.
  if (options?.echo !== false) host.appendLocalUserMessage(sessionId, text, input);
  const clientRef = `gajae-steer-${randomUUID()}`;
  const pending = (async (): Promise<MessageDelivery> => {
    let receipt: Record<string, unknown> | undefined;
    try {
      receipt = await host.controlSession(sessionId, "turn.steer", {
        text,
        clientRef,
      });
    } catch (error) {
      if (!promptPreflightNotExecutedError(error)) throw error;
      return {
        kind: "not_executed",
        detail: error.message,
      };
    }
    if (receipt?.accepted === false || receipt?.status === "rejected") {
      if (promptPreflightNotExecutedReceipt(receipt))
        return {
          kind: "not_executed",
          detail: requestFailureDetail(receipt, "GJC rejected the steering request."),
        };
      // Upstream session-runtime.ts catches every sendUserMessage rejection for
      // turn.steer, and AgentSession.#queueSteer can mutate its queue before a
      // downstream throw. A generic rejected receipt therefore does not prove
      // that no work began; only the canonical typed preflight error does.
      throw new Error(
        requestFailureDetail(receipt, "GJC rejected the steering request."),
      );
    }
    const status = await reconcileRequestQuery(host,
      sessionId,
      "turn.steer_status",
      { clientRef },
      (record) =>
        record.status === "accepted" ||
        record.status === "rejected" ||
        record.status === "unknown" ||
        (record.status === "uncertain" &&
          typeof record.terminalAt === "number"),
    );
    if (status?.status === "rejected") {
      if (promptPreflightNotExecutedReceipt(status))
        return {
          kind: "not_executed",
          detail: requestFailureDetail(status, "GJC rejected the steering request."),
        };
      throw new Error(
        requestFailureDetail(status, "GJC rejected the steering request."),
      );
    }
    return "steer";
  })();
  const previous = host.pendingSteers.get(sessionId);
  const chained = previous
    ? previous.then(
        () => pending,
        () => pending,
      )
    : pending;
  host.pendingSteers.set(sessionId, chained);
  try {
    return await pending;
  } finally {
    if (host.pendingSteers.get(sessionId) === chained)
      host.pendingSteers.delete(sessionId);
  }
}

export async function queueFollowUp(
  host: ControlHost,
  sessionId: string,
  input: ResolvedMessageInput,
): Promise<MessageDelivery> {
  host.locallyAbortedSessions.delete(sessionId);
  const text = messageTextWithFiles(input);
  if (!text) throw new Error("Follow-up text is required");
  try {
    await host.ensureAttached(sessionId, false);
  } catch {
    if (
      !host.terminalOnlySessions.has(sessionId) ||
      host.sessions.get(sessionId)?.ownership !== "external"
    )
      throw new Error("세션 제어 상태를 확인할 수 없어 후속 메시지를 보내지 않았습니다.");
  }
  let receipt: Record<string, unknown> | undefined;
  try {
    receipt = await host.controlSession(sessionId, "turn.follow_up", {
      text,
    });
  } catch (error) {
    if (!promptPreflightNotExecutedError(error)) throw error;
    return {
      kind: "not_executed",
      detail: error.message,
    };
  }
  if (receipt?.accepted === false || receipt?.status === "rejected") {
    if (promptPreflightNotExecutedReceipt(receipt))
      return {
        kind: "not_executed",
        detail: requestFailureDetail(receipt, "GJC rejected the follow-up request."),
      };
    throw new Error(
      requestFailureDetail(receipt, "GJC rejected the follow-up request."),
    );
  }
  const commandId = receipt?.commandId;
  const turnId = receipt?.turnId;
  if (typeof commandId !== "string" || typeof turnId !== "string")
    return "prompt";
  const result = await reconcileRequestQuery(host,
    sessionId,
    "turn.result",
    { kind: "prompt", commandId, turnId },
    (record) =>
      record.status === "terminal_ok" ||
      record.status === "failed" ||
      record.status === "unknown",
  );
  if (result?.status === "failed") {
    if (result.startedAt === undefined)
      return {
        kind: "not_executed",
        detail: requestFailureDetail(
          result,
          "GJC confirmed that the follow-up failed before execution.",
        ),
      };
    if (typeof result.startedAt !== "number" || !Number.isFinite(result.startedAt))
      return "prompt";
    throw new Error(
      requestFailureDetail(
        result,
        "GJC reported a follow-up failure after execution started.",
      ),
    );
  }
  return "prompt";
}

/**
 * One control operation over `gjc sdk session raw control`.
 *
 * There used to be a private in-process extension path with this CLI as fallback,
 * and the two could disagree about whether an operation was accepted. The CLI is
 * now the only path, so there is one answer per operation and no fallback to
 * reconcile.
 */
export async function controlSession(
  host: ControlHost,
  sessionId: string,
  operation:
    | "turn.prompt"
    | "turn.steer"
    | "turn.follow_up"
    | "turn.abort"
    | "queue.message.remove"
    | "compaction.run"
    | "mode.goal.operate"
    | "mode.plan.set"
    | "thinking.set"
    | "thinking.cycle"
    | "model.profile.set"
    | "permission_mode.set"
    | "config.patch"
    | "service_tier.set"
    | "session.export_html"
    | "context.clear"
    | "session.rename"
    | "session.cwd.move"
    | "retry.last"
    | "bash.background"
    | "runtime.reload"
    | "auth.login"
    | "btw.ask"
    | "workflow.gate_answer",
  input: Record<string, unknown>,
  options?: { confirm?: boolean; idempotencyKey?: string; timeoutMs?: number },
): Promise<Record<string, unknown> | undefined> {
  const cli = await host.requireCli();
  // A terminal abort is the only operation that needs a key of its own, and the
  // key must be stable across a retry of the same user action.
  const idempotencyKey =
    options?.idempotencyKey ??
    (operation === "turn.abort" && input.mode === "terminal"
      ? `gajae-abort-${randomUUID()}`
      : undefined);
  try {
    return await cli.rawControl(sessionId, operation, input, {
      repo: host.repoFor(sessionId),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      // An operator terminal abort is destructive and the host requires the flag.
      confirm: options?.confirm === true || input.operator === true,
    });
  } catch (error) {
    if (busyPromptError(error)) throw error;
    // A session with no SDK endpoint is reported once, in terms the user can act
    // on, instead of each caller surfacing the broker's routing language.
    if (isSessionUnreachable(error)) {
      if (operation === "turn.abort" && input.operator === true) {
        try {
          await cli.queryItems(sessionId, "session.metadata", {}, { repo: host.repoFor(sessionId) });
        } catch {
          host.markTerminalOnly(sessionId);
          throw new Error(SHARED_ROUTE_UNAVAILABLE_MESSAGE);
        }
        host.terminalOnlySessions.delete(sessionId);
        throw new OwnedStopUnavailableError();
      }
      host.markTerminalOnly(sessionId);
      throw new Error(SHARED_ROUTE_UNAVAILABLE_MESSAGE);
    }
    throw new Error(brokerFailureMessage(error));
  }
}

export async function listQueuedMessages(host: ControlHost, sessionId: string): Promise<QueuedMessage[]> {
  try {
    const queued: QueuedMessage[] = [];
    for (const row of await host.querySessionItems(
      sessionId,
      "queue.messages.list",
      {},
      { strict: true },
    )) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const value = row as Record<string, unknown>;
      if (typeof value.id !== "string" || typeof value.text !== "string")
        continue;
      const mode = value.mode === "steer" ? "steer" : "followUp";
      queued.push({
        id: value.id,
        text: value.text,
        mode,
        label:
          typeof value.label === "string" && value.label
            ? value.label
            : mode === "steer"
              ? "Steer"
              : "Queued",
      });
    }
    return queued;
  } catch {
    return [];
  }
}

/**
 * GJC CLI empty submit: interrupt the current stream so the window can hand over
 * the requests it is holding.
 */
export async function flushQueuedNow(host: ControlHost, sessionId: string): Promise<boolean> {
  if (host.flushingSessions.has(sessionId)) return true;
  host.flushingSessions.add(sessionId);
  try {
    const pendingSteer = host.pendingSteers.get(sessionId);
    if (pendingSteer) await pendingSteer.catch(() => undefined);
    // The window owns its pending queue, so it already knows there is work to
    // release. GJC reports no waiting steer of its own -- turn.steer is consumed
    // by the open turn -- so there is nothing here to confirm against.
    //
    // A host that refuses the operator-owned Stop still serves ordinary control,
    // and the held work is released by the renderer as a steer that the next turn
    // boundary consumes. Failing that refusal here would leave the user's text
    // stuck in the composer over a stop this window was never able to substantiate
    // anyway, so the refusal is not an error for a release. A session the metadata
    // probe could not reach still throws (see controlSession).
    let stopped = false;
    try {
      await abortOwnedThroughControl(host, sessionId);
      stopped = true;
    } catch (error) {
      if (!(error instanceof OwnedStopUnavailableError)) throw error;
    }
    // A release only marks the row running when a turn could not be stopped. A
    // confirmed stop means the turn is over, and a host that never granted this
    // window the operator Stop is answered by the transcript instead. Publishing
    // running unconditionally was how a release against an already finished row
    // left it looking mid-turn: every later message then arrived as a steer
    // behind a turn that had ended, which is the queue the user watched swallow
    // their text.
    const stillRunning =
      !stopped && (await host.discoveredRunState(sessionId)) === "running";
    host.updateSessionStatus(sessionId, stillRunning ? "running" : "idle", {
      announce: false,
    });
    return true;
  } catch (error) {
    if (uncertainAfterSendError(error) || cancelledOperationError(error)) {
      host.updateSessionStatus(sessionId, "running");
      return true;
    }
    throw error;
  } finally {
    host.flushingSessions.delete(sessionId);
  }
}

export async function sendMessage(
  host: ControlHost,
  sessionId: string,
  input: ResolvedMessageInput,
  options?: SendMessageOptions,
): Promise<MessageDelivery> {
  host.locallyAbortedSessions.delete(sessionId);
  if (await host.executeSdkSlashCommand(sessionId, input, options))
    return "prompt";
  const value = input.text.trim();
  if (/^\/steer(?:\s+|$)/u.test(value)) {
    return await steerSession(host, sessionId, input);
  }
  // `bare` is the user's own text; `promptText` adds the attachment block.
  // steerSession composes the block itself, so the steer fallbacks below hand
  // it `bare` -- passing promptText appended the same block a second time.
  const bare = value.replace(/^\/queue(?:\s+|$)/u, "").trim();
  const promptText = bare + attachedPathsText(input);
  if (!promptText) return "prompt";
  const session = host.sessions.get(sessionId);
  if (
    host.activePromptSessions.has(sessionId) ||
    session?.status === "running"
  ) {
    return await steerSession(host, sessionId, { ...input, text: bare });
  }
  const admission = Symbol(sessionId);
  const admissionGeneration = host.generation;
  host.activePromptAdmissions.set(sessionId, admission);
  host.activePromptSessions.add(sessionId);
  const settleNotExecuted = async (detail: string): Promise<MessageDelivery> => {
    if (host.activePromptAdmissions.get(sessionId) !== admission)
      return "prompt";
    const settlementGeneration = host.generation;
    const settlementRevision = host.currentRunRevision(sessionId);
    host.activePromptAdmissions.delete(sessionId);
    host.activePromptSessions.delete(sessionId);
    const runState = await host.discoveredRunState(sessionId);
    if (
      runState !== undefined &&
      host.activePromptAdmissions.get(sessionId) === undefined &&
      settlementGeneration === host.generation &&
      settlementRevision === host.currentRunRevision(sessionId)
    )
      host.updateSessionStatus(sessionId, runState, { announce: false });
    return { kind: "not_executed", detail };
  };

  // The bubble is echoed before any await so the window shows the request the
  // moment it is submitted. Connecting and attaching are round trips, and doing
  // them first left the composer looking like it had swallowed the message.
  host.activeAssistantMessages.delete(sessionId);
  host.finalizeThought(sessionId);
  host.appendLocalUserMessage(sessionId, promptText, input);
  host.updateSessionStatus(sessionId, "running");

  try {
    const cli = await host.requireCli();
    await host.ensureAttached(sessionId, false);
    // One fresh operation reference per logical prompt. A reused reference is
    // rejected as a conflict while its record is retained, and after eviction it
    // could be admitted again with the first outcome unknown, so a retry must
    // never recycle one.
    const operationRef = freshOperationRef();
    let accepted: Awaited<ReturnType<GjcSdkCli["send"]>> | undefined;
    let uncertain = false;
    try {
      accepted = await cli.send(sessionId, promptText, {
        repo: host.repoFor(sessionId),
        opRef: operationRef,
      });
    } catch (error) {
      if (!uncertainAfterSendError(error)) throw error;
      // The frame may already have reached the host. Never resend while the
      // outcome is unknown or reuse its reference; reconcile that exact
      // reference instead.
      uncertain = true;
    }
    // `send` returning means the prompt was *accepted*, not that the agent
    // stopped. A follow-up turn, a released steer, or background work keeps running
    // and keeps appending to the transcript, so closing the row here reported 완료
    // over live work. The prompt record and the session's own transcript are the
    // accounts that cover what a single CLI call cannot see, so they decide.
    const settledOperationRef = accepted?.operationRef ?? operationRef;
    const settlement =
      accepted?.status === "failed"
        ? {
            kind: "not_executed" as const,
            detail: "GJC rejected the prompt",
          }
        : await host.awaitPromptSettlement(
            sessionId,
            settledOperationRef,
            () => host.activePromptAdmissions.get(sessionId) === admission,
          );
    if (settlement === "unknown" && uncertain) {
      // This send may have been cancelled and replaced while its settlement
      // was being read. Only the original admission may publish the run state.
      if (host.activePromptAdmissions.get(sessionId) === admission)
        host.updateSessionStatus(sessionId, "running");
      return "prompt";
    }
    if (typeof settlement === "object") {
      return await settleNotExecuted(settlement.detail);
    }
    if (settlement === "unknown") {
      // Poll exhaustion or unavailable evidence is not a terminal event. The
      // file watcher and tail follower remain responsible for the later state.
      if (host.activePromptAdmissions.get(sessionId) === admission)
        host.updateSessionStatus(sessionId, "running");
      return "prompt";
    }
    // A cancel or a newer prompt may have replaced this run while its
    // settlement was being read. Finalizing now would close the thought and
    // stream of the run that owns the row instead.
    if (host.activePromptAdmissions.get(sessionId) !== admission)
      return "prompt";
    host.finalizeThought(sessionId);
    host.finalizeAssistantMessage(sessionId);
    await host.refreshContextUsage(sessionId, { force: true });
    // updateSessionStatus announces the running -> idle transition itself.
    //
    // The prompt is released before the read because the run-state cache is keyed on
    // the file, not the caller, and leaving this session marked as actively prompted
    // would let a concurrent republish skip it. `finally` releasing it again is a
    // no-op on a Set.
    const settlementGeneration = host.generation;
    const settlementRevision = host.currentRunRevision(sessionId);
    const ownsRow = host.activePromptAdmissions.get(sessionId) === admission;
    if (ownsRow) {
      host.activePromptAdmissions.delete(sessionId);
      host.activePromptSessions.delete(sessionId);
    }
    const stillRunning = await host.discoveredRunState(sessionId);
    if (
      ownsRow &&
      stillRunning !== undefined &&
      settlementGeneration === host.generation &&
      settlementRevision === host.currentRunRevision(sessionId)
    )
      host.updateSessionStatus(sessionId, stillRunning);
  } catch (caught) {
    let error: unknown = caught;
    // The user cancelled this send, or a newer prompt took the row while this
    // one was in flight. Its late failure belongs to a run that no longer
    // owns the window: settling here finalized the newer run's streaming
    // message, published idle over it, and appended a failure notice for the
    // prompt that was already cancelled.
    if (host.activePromptAdmissions.get(sessionId) !== admission)
      return "prompt";
    if (promptPreflightNotExecutedError(error))
      return await settleNotExecuted(error.message);
    if (busyPromptError(error)) {
      host.activePromptSessions.delete(sessionId);
      return await steerSession(host,
        sessionId,
        { ...input, text: bare },
        { echo: false },
      );
    }
    if (isSessionUnreachable(error)) {
      host.markTerminalOnly(sessionId);
      error = new Error(SHARED_ROUTE_UNAVAILABLE_MESSAGE);
    }
    host.finalizeThought(sessionId);
    host.finalizeAssistantMessage(sessionId);
    void host.refreshContextUsage(sessionId, { force: true });
    if (cancelledOperationError(error)) {
      // A cancel is the user's own action, so it settles quietly.
      host.updateSessionStatus(sessionId, "idle", { announce: false });
      appendCancelledNotice(host, sessionId);
      return "prompt";
    }
    // A failed run is announced as a failure below, so the idle transition must
    // not also announce a completion.
    host.updateSessionStatus(sessionId, "idle", { announce: false });
    const notice: NoticeActivity = {
      id: `gjc-error-${host.nextLocalId++}`,
      kind: "notice",
      sessionId,
      title: "GJC run failed",
      content: error instanceof Error ? error.message : String(error),
      tone: "warning",
      createdAt: nowLabel(),
    };
    host.appendTranscript(notice);
    host.emitActivity(sessionId, "failed");
    throw error;
  } finally {
    if (host.activePromptAdmissions.get(sessionId) === admission) {
      host.activePromptAdmissions.delete(sessionId);
      host.activePromptSessions.delete(sessionId);
      queueMicrotask(() => {
        if (
          host.disposed ||
          admissionGeneration !== host.generation ||
          host.activePromptAdmissions.has(sessionId) ||
          host.activePromptSessions.has(sessionId) ||
          host.sessions.get(sessionId)?.status !== "running"
        )
          return;
        void host.republishRunState(sessionId);
      });
    }
  }
  return "prompt";
}

/**
 * Reconciles one exact SDK selector for at most twenty seconds. `turn.result`
 * and `turn.steer_status` are read-only; unknown, unavailable, and timed-out
 * outcomes remain unknown and never authorize another submission.
 */
async function reconcileRequestQuery(
  host: ControlHost,
  sessionId: string,
  query: "turn.result" | "turn.steer_status",
  input: Record<string, unknown>,
  isTerminal: (record: Record<string, unknown>) => boolean,
  isCurrent?: () => boolean,
): Promise<Record<string, unknown> | undefined> {
  const generation = host.generation;
  const cancellationWatermark = host.cancellationWatermarks.get(sessionId);
  const deadline = Date.now() + REQUEST_OUTCOME_RECONCILIATION_BUDGET_MS;
  const wasCancelledOrReplaced = () =>
    host.disposed ||
    generation !== host.generation ||
    host.locallyAbortedSessions.has(sessionId) ||
    host.cancellationWatermarks.get(sessionId) !== cancellationWatermark ||
    isCurrent?.() === false;

  while (!wasCancelledOrReplaced()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    let record: Record<string, unknown> | undefined;
    let queryFailed = false;
    try {
      const cli = await host.requireCli();
      if (wasCancelledOrReplaced()) return undefined;
      const queryTimeout = Math.min(
        REQUEST_OUTCOME_QUERY_TIMEOUT_MS,
        deadline - Date.now(),
      );
      if (queryTimeout <= 0) return undefined;
      const envelope = await cli.rawQuery(sessionId, query, input, {
        repo: host.repoFor(sessionId),
        timeoutMs: queryTimeout,
      });
      record = envelopeResult(envelope);
    } catch {
      if (wasCancelledOrReplaced()) return undefined;
      queryFailed = true;
    }
    if (wasCancelledOrReplaced()) return undefined;
    if (queryFailed) {
      const waitMs = Math.min(
        REQUEST_OUTCOME_RECONCILIATION_INTERVAL_MS,
        deadline - Date.now(),
      );
      if (waitMs <= 0) return undefined;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (!record) return { status: "unknown" };
    const normalized = {
      ...record,
      status: typeof record.status === "string" ? record.status : "unknown",
    };
    if (normalized.status === "unknown" || isTerminal(normalized))
      return normalized;
    const waitMs = Math.min(
      REQUEST_OUTCOME_RECONCILIATION_INTERVAL_MS,
      deadline - Date.now(),
    );
    if (waitMs <= 0) return undefined;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return undefined;
}

/**
 * Waits for an accepted prompt to reach a terminal record.
 *
 * The semantic `send` call returns at acceptance rather than holding open for the
 * whole turn, so the window's spinner and final status need reconciliation. The
 * turn is followed here instead: `turn.result` is the lossless record, and the
 * transcript is watched in parallel by the session-file watcher.
 *
 * A prompt that is still running when the poll budget ends is left running. This
 * never forces the row idle and never reports a cancel, because `unknown` and
 * "still going" are both uncertainty, not proof the work stopped.
 *
 * A failed record without `startedAt` is returned as a request-scoped outcome.
 * Poll exhaustion, query errors, and unknown selectors remain unknown; callers
 * must not replay any of them.
 */
export async function awaitPromptSettlement(
  host: ControlHost,
  sessionId: string,
  operationRef: string,
  isCurrent?: () => boolean,
): Promise<
  | "terminal"
  | "unknown"
  | { kind: "not_executed"; detail: string }
> {
  const record = await reconcileRequestQuery(host,
    sessionId,
    "turn.result",
    { kind: "prompt", clientRef: operationRef },
    (result) =>
      result.status === "terminal_ok" ||
      result.status === "failed" ||
      result.status === "unknown",
    isCurrent,
  );
  if (!record || record.status === "unknown") return "unknown";
  if (record.status === "failed") {
    if (record.startedAt === undefined)
      return {
        kind: "not_executed",
        detail: requestFailureDetail(record, PROMPT_NOT_EXECUTED_MESSAGE),
      };
    if (typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt))
      return "unknown";
    const error =
      record.error && typeof record.error === "object"
        ? (record.error as Record<string, unknown>)
        : undefined;
    if (error?.code === "aborted" || error?.code === "cancelled")
      return "terminal";
    throw new Error(requestFailureDetail(record, "GJC run failed."));
  }
  return record.status === "terminal_ok" ? "terminal" : "unknown";
}

export async function cancelRun(host: ControlHost, sessionId: string): Promise<void> {
  const previous = host.cancellationPromises.get(sessionId);
  if (previous) return previous;
  let resolveCancellation!: () => void;
  let rejectCancellation!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCancellation = resolve;
    rejectCancellation = reject;
  });
  // The initiating caller receives the original error below; keep the shared
  // promise from becoming an unhandled rejection when no concurrent caller
  // is waiting on it.
  void completion.catch(() => undefined);
  host.cancellationPromises.set(sessionId, completion);
  host.cancellingSessions.add(sessionId);
  try {
    const stop = await host.fireAbort(sessionId);
    if (stop === "no_active_turn") {
      // Nothing was running, so nothing was cancelled: the run state this window
      // was showing is cleared so the row settles at idle, and the transcript is
      // left alone -- it stays the source of truth for whether work continued on
      // another connection. A notice here would claim a stop that did not happen.
      throw new Error("GJC가 현재 연결에서 활성 turn을 찾지 못했습니다. 세션 작업의 중지 여부는 확인되지 않았습니다.");
    } else {
      host.finalizeThought(sessionId);
      host.finalizeAssistantMessage(sessionId);
      host.finalizeAllMessages(sessionId);
      host.toolSnapshots.delete(sessionId);
      host.cancelOpenTools(sessionId);
      host.settleOpenQuestions(sessionId, "cancelled");
      host.cancelPermissionsForSession(sessionId);
      appendCancelledNotice(host, sessionId, stop === "plain");
      host.locallyAbortedSessions.add(sessionId);
      host.cancellationWatermarks.set(sessionId, Date.now());
      host.activePromptAdmissions.delete(sessionId);
      host.activePromptSessions.delete(sessionId);
      // Only confirmed aborts may clear run authority and publish idle.
      clearRunState(host, sessionId);
    }
    host.updateSessionStatus(sessionId, "idle");
    resolveCancellation();
  } catch (error) {
    // No state was cleared before confirmation, so keep whatever the runtime
    // currently reports instead of inventing running work for an idle session.
    rejectCancellation(error);
    throw error;
  } finally {
    host.cancellingSessions.delete(sessionId);
    if (host.cancellationPromises.get(sessionId) === completion)
      host.cancellationPromises.delete(sessionId);
  }
  return completion;
}

/**
 * Drops this window's run-authority state for a session whose run is over.
 */
function clearRunState(host: ControlHost, sessionId: string): void {
  host.liveRunningSessions.delete(sessionId);
  host.liveRunningDigests.delete(sessionId);
  host.liveEvidenceAt.delete(sessionId);
  host.transcriptRunningSessions.delete(sessionId);
  host.workingPhaseSessions.delete(sessionId);
  host.runtimeIdleSessions.delete(sessionId);
  host.pendingAsyncWorkSessions.delete(sessionId);
  host.discoveredRunStates.delete(sessionId);
  host.compactingSessions.delete(sessionId);
  host.compactionRecordBaseline.delete(sessionId);
  host.compactionStartedAt.delete(sessionId);
}

/**
 * Stops the run, through the operator route when the host serves it and through the
 * ordinary abort when the host answers but refuses the operator-owned Stop.
 *
 * The result names what was confirmed: `owned` stopped this window's turn and the
 * work the runtime counts as owned, `plain` stopped the turn through the ordinary
 * route only, and `no_active_turn` means there was no turn to stop at all.
 */
export async function fireAbort(
  host: ControlHost,
  sessionId: string,
): Promise<"owned" | "plain" | "no_active_turn"> {
  try {
    await abortOwnedThroughControl(host, sessionId);
    return "owned";
  } catch (error) {
    if (!(error instanceof OwnedStopUnavailableError)) throw error;
  }
  const disposition = await abortPlainThroughControl(host, sessionId);
  return disposition === "stopped" ? "plain" : "no_active_turn";
}

/**
 * Ordinary `turn.abort` -- the payload and route a CLI cancel uses.
 *
 * Verified against gjc/0.18.11: `session-cli.ts` diverts `turn.abort` to the broker
 * `session.control` route only when the payload carries an `operator` key
 * (`operatorAbortBrokerRequest`), so this shape travels the ordinary Router control
 * path a directly launched TUI host does serve. Its dispositions (`session-runtime`
 * `abort`) are `{aborted:true}` -- the run is gone -- for this connection's own
 * turn, `{aborted:false, turn:"no_active_turn"}` when this connection owned no
 * active run, and `{aborted:false, reason:"queue_terminal_unconfirmed"}` when it
 * could not confirm. `turn:"stopped"` is the terminal-abort confirmation, accepted
 * here too so a runtime that answers the ordinary route with the terminal
 * disposition still reads as confirmed.
 *
 * Only a confirmation counts as stopped. The ordinary route stops this connection's
 * turn and nothing the runtime holds as work owned by another connection, so its
 * confirmation never substantiates that owned background work stopped.
 *
 * A route failure is reported as the owned-stop refusal instead of marking the
 * session read-only: a refused Stop is not evidence that the session lost ordinary
 * control (the metadata probe just proved it answers), and the refusal keeps the
 * retry guidance the user can act on.
 */
async function abortPlainThroughControl(
  host: ControlHost,
  sessionId: string,
): Promise<"stopped" | "no_active_turn"> {
  const cli = await host.requireCli();
  const answer = await cli
    .rawControl(sessionId, "turn.abort", {}, { repo: host.repoFor(sessionId) })
    .catch((error: unknown): never => {
      throw new OwnedStopUnavailableError(error);
    });
  if (answer?.turn === "stopped" || answer?.aborted === true) return "stopped";
  // No active turn on this connection: nothing was stopped, and that is not a
  // failure to report.
  if (answer?.turn === "no_active_turn") return "no_active_turn";
  throw new Error(
    `GJC가 작업 중지를 확정하지 못했습니다. 응답: ${JSON.stringify(answer ?? null)}`,
  );
}

export function appendCancelledNotice(
  host: ControlHost,
  sessionId: string,
  ownedWorkUnconfirmed = false,
): void {
  // A plain abort stops this connection's turn; reaching the work the runtime
  // counts as owned needs the operator route, so that cancel states the limit in
  // one sentence instead of claiming background work stopped.
  const content = ownedWorkUnconfirmed
    ? "진행 중인 작업이 취소되어 종료됐습니다. 다만 이 호스트의 백그라운드 작업은 중지 여부가 확인되지 않았습니다."
    : "진행 중인 작업이 취소되어 종료됐습니다.";
  const items = host.transcripts.get(sessionId) ?? [];
  // The persisted transcript reports an aborted turn as `shared-cancelled-`,
  // so checking only for this window's own prefix announced the same
  // cancellation a second time once the rebuild had already landed. The caveat is
  // part of the notice, so a cancel that states it is not swallowed by an earlier
  // cancel that does not.
  if (
    items.some(
      (item) =>
        item.kind === "notice" &&
        item.title === "작업 취소됨" &&
        item.content === content,
    )
  )
    return;
  host.appendTranscript({
    id: `gjc-cancelled-${host.nextLocalId++}`,
    kind: "notice",
    sessionId,
    title: "작업 취소됨",
    content,
    tone: "neutral",
    createdAt: nowLabel(),
  });
}

/**
 * Stops the current turn and this window's own background work.
 *
 * Terminal abort is session-scoped: it cancels the current turn and exactly the
 * owned background work without signalling or closing the GJC session process.
 * A signal is never sent -- SIGINT would take down a session the user may be
 * sharing with a terminal.
 *
 * The payload carries only `mode`/`scope`/`operator`: the host validates terminal
 * abort input strictly and rejects any other key (including `confirm` and
 * `idempotencyKey`, which travel as CLI flags) with `usage`. Verified against
 * gjc/0.18.11: adding a `clientRef` or `turnId` field to the terminal payload is
 * rejected before dispatch.
 *
 * Only `turn: "stopped"` is a confirmation. The historical gjc/0.18.11 bug
 * (fixed in 0.18.12) answered the typed disposition `{turn:"no_active_turn", terminal:"terminal_no_effect"}` when the
 * broker route cannot see the host's active prompt -- reproducible while a turn is
 * verifiably running (`status` in_flight and `turn.steer` accepted on the same
 * session) -- and the turn keeps running. Reporting that as a cancellation would
 * tell the user work stopped while it is still going, so the failure is surfaced
 * instead and the local run state is left untouched.
 */
async function abortOwnedThroughControl(
  host: ControlHost,
  sessionId: string,
): Promise<Record<string, unknown>> {
  // The local running event precedes the host's broker registration. A Stop
  // pressed in that gap answers `no_active_turn` even though the prompt is
  // being accepted, so re-ask briefly before reporting the stop unconfirmed.
  let result: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const idempotencyKey = `gajae-abort-${randomUUID()}`;
    result = await host.controlSession(
      sessionId,
      "turn.abort",
      {
        mode: "terminal",
        scope: "owned",
        operator: true,
      },
      { idempotencyKey, confirm: true },
    );
    if (result?.turn === "stopped") return result;
    if (result?.turn !== "no_active_turn" || attempt === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `GJC가 작업 중지를 확정하지 못했습니다. 응답: ${JSON.stringify(result ?? null)}`,
  );
}
