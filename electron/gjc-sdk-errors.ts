import { homedir } from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { DEFAULT_MODEL_PRESET } from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";
import {
  GjcSdkCli,
  SdkCliError,
  brokerExec,
  freshOperationRef,
  isLifecycleUncertain,
  isSessionMissing,
  isSessionUnreachable,
  type SdkSessionRow,
} from "./gjc-sdk-cli.js";


/**
 * Transcript and event shapes.
 *
 * Gajae reads these updates from the session's own file under
 * `~/.gjc/agent/sessions/` and from `gjc sdk session tail` frames, so the shapes
 * are declared here instead of imported from a protocol package. The field names
 * match what GJC persists, which is what both sources carry.
 */

export function missingSessionError(error: unknown): boolean {
  if (isSessionMissing(error)) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /saved session does not exist|session is not indexed|unknown GJC session/iu.test(
    text,
  );
}

export function lifecycleUncertainError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /terminal_uncertain|lifecycle terminal evidence could not be verified|retained artifacts require reconciliation|cleanup authority is uncertain|cannot be deleted safely|requires durable locator authority|ownership is uncertain|authority is ambiguous|authority is pending/iu.test(
    text,
  );
}

/**
 * A lifecycle mutation whose outcome GJC could not establish.
 *
 * gjc/0.18.11 answers `session.delete` with `operation_failed` and "The operation
 * failed. Its outcome could not be established." (`outcomeCertainty: unknown`,
 * retryability `unknown`, next step "do not blindly retry") on the installed build,
 * reproducibly and in a fresh agent directory, while the broker row stays
 * `deleted: false`. It is not proof that the delete landed or failed, so it must be
 * handled the way this file handles every other unknown lifecycle outcome: re-read
 * the broker row and let only that evidence decide.
 */
export function uncertainLifecycleOutcomeError(error: unknown): boolean {
  if (!(error instanceof SdkCliError)) return false
  return (
    error.code === "operation_failed" &&
    (error.outcomeCertainty === "unknown" ||
      /outcome could not be established/iu.test(error.message))
  )
}

export function lifecycleInputRefused(error: unknown): boolean {
  return (
    error instanceof SdkCliError &&
    error.diagnostics.some(
      (diagnostic) => diagnostic.code === "lifecycle_input_refused",
    )
  )
}

export function lifecycleLegacyHistoryAmbiguous(error: unknown): boolean {
  return (
    error instanceof SdkCliError &&
    error.diagnostics.some(
      (diagnostic) => diagnostic.code === "lifecycle_legacy_history_ambiguous",
    )
  )
}

export function liveSessionDeleteError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /live_session|refusing to delete a live session/iu.test(text);
}

export function missingLifecycleSessionError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /not_found|session is not indexed|does not exist/iu.test(text);
}

export function busyPromptError(error: unknown): boolean {
  // gjc/0.18.11 answers a second prompt with the typed code `busy` and the text
  // "The session is running a turn and refused the request." (verified). The
  // message patterns below are the older ones and no longer match that text, so
  // without the code check a follow-up typed during a run surfaced as a raw error
  // instead of being delivered as a steer.
  if (error instanceof SdkCliError) {
    if (error.code === "busy" || error.code === "prompt_busy" || error.code === "agent_busy")
      return true;
  }
  const text = error instanceof Error ? error.message : String(error);
  return /already has an active prompt|is running a turn and refused|turn\.prompt is unavailable while the agent is busy|agent is busy.*turn\.steer|prompt_busy|agent_busy/iu.test(
    text,
  );
}

export function cancelledOperationError(error: unknown): boolean {
  const value =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /\b(?:operation[ _-]?aborted|operation[ _-]?cancelled|operation[ _-]?canceled|aborterror|request aborted)\b/iu.test(
    value,
  );
}
export function uncertainAfterSendError(error: unknown): boolean {
  if (error instanceof SdkCliError && error.code === "uncertain_after_send")
    return true;
  const text = error instanceof Error ? error.message : String(error);
  return /uncertain_after_send|SDK request outcome is uncertain after the frame was sent|request was sent but its outcome is uncertain/iu.test(
    text,
  );
}

export function brokerFailureMessage(error: unknown): string {
  const candidate =
    error && typeof error === "object"
      ? (error as { stdout?: unknown; stderr?: unknown; message?: unknown })
      : undefined;
  for (const output of [candidate?.stdout, candidate?.stderr]) {
    if (typeof output !== "string" || !output.trim()) continue;
    try {
      const parsed = JSON.parse(output) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string" && parsed.error.message)
        return parsed.error.message;
    } catch {
      return output.trim();
    }
  }
  return typeof candidate?.message === "string"
    ? candidate.message
    : String(error);
}

// Shown when a live session has no shared control route this window can use. It
// names the route and the retry rather than the process that might hold the
// session: a live row the broker cannot route to is not proof that a terminal owns
// it, and the session itself is never closed, resumed, or replaced by this message.
export const SHARED_ROUTE_UNAVAILABLE_MESSAGE =
  "이 세션의 공유 제어 경로를 확인할 수 없습니다. 세션과 기록은 그대로 유지됩니다. GJC에서 세션을 다시 열거나 잠시 뒤 다시 시도하면 이어서 제어할 수 있습니다.";

// Shown when the session answers this window but GJC refuses the operator-owned
// Stop. The broker control route requires the session's indexed
// `lifecycleRequestId` (`Broker.#sessionControlAuthority`) and the host compares it
// against `GJC_LIFECYCLE_REQUEST_ID` (`hasBrokerRuntimeAbortCapability`); a directly
// launched TUI host need not carry that identity, so metadata, prompts, and
// steering keep working while Stop is refused. The refusal is a classification
// rather than the end of the story: `flushQueuedNow` releases the work the window
// is holding instead of failing, and `cancelRun` falls back to the ordinary
// `turn.abort` route, so this text reaches the user only once no route could make
// the session stop.
export const OWNED_STOP_UNAVAILABLE_MESSAGE =
  "이 세션은 앱에서 계속 제어할 수 있지만, GJC가 이 호스트의 소유자 중지(Stop) 권한을 확인할 수 없습니다. 작업과 백그라운드 작업이 멈췄다면 그 결과는 확정되지 않았습니다. 세션이 중지를 허용하면 다시 시도해 주세요.";

/**
 * The refusal above as its own type, so callers classify it instead of matching the
 * user-facing text. `cause` carries the failure of the fallback route when one was
 * tried and did not confirm a stop.
 */
export class OwnedStopUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      OWNED_STOP_UNAVAILABLE_MESSAGE,
      ...(cause === undefined ? [] : [{ cause }]),
    );
    this.name = "OwnedStopUnavailableError";
  }
}

/**
 * Canonical identity for a workspace directory.
 *
 * The same directory reaches this controller in two forms: the path a caller hands
 * in, and the resolved `cwd` GJC reports in its broker locator. On macOS those are
 * `/var/folders/...` and `/private/var/folders/...`, which name one directory but
 * compare as two strings. Creating a session in the first form and then re-hosting
 * it left the sidebar and this controller holding both, so a fork of the re-hosted
 * session was reported in a different workspace than the session it came from. One
 * canonical form per directory keeps every comparison in this file meaningful.
 */
