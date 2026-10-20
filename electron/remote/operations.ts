import type {
  AgentSession,
  BackendConnection,
  HistorySession,
  MessageDelivery,
  QuestionActivity,
  QuestionSubmission,
  ToolDecision,
  TranscriptChange,
  TranscriptItem,
} from "../../shared/agent-contract.js";
import { transcriptDelivery } from "../../shared/transcript-item-equal.js";
import type { RemoteOperationName } from "../../shared/remote-protocol.js";
import type { ResolvedMessageInput } from "../gjc-sdk-controller.js";
import {
  messageInput,
  questionIdempotencyKey,
  questionSubmission,
  requiredId,
  toolDecision,
} from "../gjc-input-validation.js";

/**
 * The operations a remote device may run, expressed once for every transport.
 *
 * The host passes the same `GjcSdkController` the Electron IPC layer uses, so a
 * phone and the desktop drive one runtime instead of two views of it. What is
 * deliberately *not* here is as important as what is: session creation, deletion,
 * compaction, git commits and pushes keep their native confirmation dialog and
 * stay desktop-only.
 */

export interface RemoteOperationsHost {
  getConnection(): Promise<BackendConnection>;
  listSessions(): Promise<AgentSession[]>;
  listHistorySessions(): Promise<HistorySession[]>;
  getTranscript(sessionId: string): Promise<TranscriptItem[]>;
  getTranscriptRevision(sessionId: string): Promise<string | undefined>;
  refreshSessionContext(sessionId: string): Promise<void>;
  listQueuedMessages(sessionId: string): Promise<{ id: string; text: string; mode: string; label: string }[]>;
  getGoal(sessionId: string): Promise<unknown>;
  listSubagents(sessionId: string): Promise<unknown[]>;
  getGitStatus(sessionId: string): Promise<unknown>;
  getDiff(sessionId: string): Promise<unknown>;
  readArtifact(sessionId: string, artifactId: string): Promise<unknown>;
  sendMessage(sessionId: string, input: ResolvedMessageInput): Promise<MessageDelivery>;
  steerSession(sessionId: string, input: ResolvedMessageInput): Promise<void>;
  queueFollowUp(sessionId: string, input: ResolvedMessageInput): Promise<void>;
  flushQueuedNow(sessionId: string): Promise<boolean>;
  cancelRun(sessionId: string): Promise<void>;
  resolveToolCall(toolId: string, decision: ToolDecision): Promise<void>;
  listPendingQuestions(sessionId: string): Promise<QuestionActivity[]>;
  answerQuestion(
    sessionId: string,
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ): Promise<void>;
  markSessionRead(sessionId: string): Promise<void>;
}

export interface RemoteOperationParams {
  sessionId?: string;
  toolId?: string;
  artifactId?: string;
  gateId?: string;
}

/**
 * Per-device state for transcript delta reads.
 *
 * The controller's cache is shared with the desktop and is updated by its own
 * watcher, so a diff against that cache can be empty even though this remote
 * device missed the row. The server keeps what it last sent this device and
 * passes it here instead.
 */
export interface RemoteTranscriptContext {
  baseline?: readonly TranscriptItem[];
  remember?: (items: readonly TranscriptItem[]) => void;
}

/**
 * A remote device can attach images inline but cannot hand over native file
 * paths: those are resolved through desktop leases tied to a renderer process
 * that a phone does not have. Rejecting them here keeps a path string from ever
 * reaching the workspace.
 */
export function remoteMessageInput(value: unknown): ResolvedMessageInput {
  const input = messageInput(value);
  if (input.files.length > 0)
    throw new Error("Remote devices cannot attach native files; send images inline instead");
  if (input.images.some((image) => image.token))
    throw new Error("Remote devices cannot reference prepared attachments");
  return {
    text: input.text,
    images: input.images.map((image) => ({
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      data: image.data,
    })),
    files: [],
  };
}

export function remoteSessionId(value: unknown): string {
  return requiredId(value, "Session ID");
}

export async function runRemoteOperation(
  host: RemoteOperationsHost,
  operation: RemoteOperationName,
  params: RemoteOperationParams,
  body: unknown,
  transcript?: RemoteTranscriptContext,
): Promise<unknown> {
  const sessionId =
    params.sessionId === undefined ? undefined : remoteSessionId(params.sessionId);
  switch (operation) {
    case "state":
      return { connection: await host.getConnection(), sessions: await host.listSessions() };
    case "history-sessions":
      return host.listHistorySessions();
    case "transcript": {
      const items = await host.getTranscript(sessionId!);
      transcript?.remember?.(items);
      return items;
    }
    case "transcript-changes": {
      const items = await host.getTranscript(sessionId!);
      const change: TranscriptChange = transcriptDelivery(
        transcript?.baseline,
        items,
      );
      transcript?.remember?.(items);
      return change;
    }
    case "transcript-revision":
      return host.getTranscriptRevision(sessionId!);
    case "context":
      await host.refreshSessionContext(sessionId!);
      return { ok: true };
    case "queued":
      return host.listQueuedMessages(sessionId!);
    case "goal":
      return host.getGoal(sessionId!);
    case "subagents":
      return host.listSubagents(sessionId!);
    case "git-status":
      return host.getGitStatus(sessionId!);
    case "diff":
      return host.getDiff(sessionId!);
    case "artifact":
      return host.readArtifact(sessionId!, requiredId(params.artifactId, "Artifact ID"));
    case "send-message":
      return host.sendMessage(sessionId!, remoteMessageInput(messageBody(body)));
    case "steer":
      return host.steerSession(sessionId!, remoteMessageInput(messageBody(body)));
    case "queue-follow-up":
      return host.queueFollowUp(sessionId!, remoteMessageInput(messageBody(body)));
    case "flush-follow-ups":
      return host.flushQueuedNow(sessionId!);
    case "cancel-run":
      return host.cancelRun(sessionId!);
    case "resolve-tool-call":
      return host.resolveToolCall(
        requiredId(params.toolId, "Tool call ID"),
        toolDecision(decisionBody(body)),
      );
    case "pending-questions":
      return host.listPendingQuestions(sessionId!);
    case "answer-question": {
      const answer = questionBody(body);
      return host.answerQuestion(
        sessionId!,
        requiredId(params.gateId, "Question ID"),
        questionSubmission(answer.submission),
        questionIdempotencyKey(answer.idempotencyKey),
      );
    }
    case "mark-read":
      return host.markSessionRead(sessionId!);
    default: {
      const exhaustive: never = operation;
      throw new Error(`Unsupported remote operation: ${String(exhaustive)}`);
    }
  }
}

function messageBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Message input is required");
  const input = (body as { input?: unknown }).input;
  if (input === undefined) throw new Error("Message input is required");
  return input;
}

function questionBody(body: unknown): { submission: unknown; idempotencyKey: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Question answer is required");
  const record = body as { submission?: unknown; idempotencyKey?: unknown };
  if (record.submission === undefined) throw new Error("Question answer is required");
  return { submission: record.submission, idempotencyKey: record.idempotencyKey };
}

function decisionBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Tool decision is required");
  const decision = (body as { decision?: unknown }).decision;
  if (decision === undefined) throw new Error("Tool decision is required");
  return decision;
}
