import { randomUUID } from "node:crypto";
import type { FSWatcher } from "node:fs";
import type { AgentCommand, AgentConfigOption, AgentConfigOptionValue, AgentControlPreferences, AgentEvent, AgentSession, CreateSessionInput, PlanActivity, QuestionActivity, TranscriptItem } from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";
import { GjcSdkCli, isLifecycleUncertain, SdkCliError, type SdkSessionRow } from "./gjc-sdk-cli.js";
import {
  canonicalWorkspace,
  execFile,
  GJC_ACCENT,
  LIFECYCLE_RECOVERY_ATTEMPTS,
  LIFECYCLE_RECOVERY_CLOCK_SLACK_MS,
  LIFECYCLE_RECOVERY_INTERVAL_MS,
  lifecycleInputRefused,
  lifecycleLegacyHistoryAmbiguous,
  lifecycleUncertainError,
  liveSessionDeleteError,
  markUpdated,
  missingLifecycleSessionError,
  missingSessionError,
  TodoSnapshotState,
  uncertainLifecycleOutcomeError,
} from "./gjc-sdk-foundation.js";
import { remotesWithBranch } from "./gjc-sdk-git.js";
import { CliDeleteError } from "./gjc-cli-session-delete.js";
import path from "node:path";

/** The controller members session create, fork, rename and delete read and write. */
export interface LifecycleHost {
  requireCli(): Promise<GjcSdkCli>;
  nextLocalId: number;
  readonly sessions: Map<string, AgentSession>;
  brokerSessions(options?: {
    scope?: "repo" | "cwd" | "worktree" | "all";
    initialDiscovery?: boolean;
  }): Promise<SdkSessionRow[] | undefined>;
  readonly modelPreset: AgentControlPreferences["modelPreset"];
  readonly sessionCwds: Map<string, string>;
  readonly transcripts: Map<string, TranscriptItem[]>;
  readonly toolRowIndices: Map<string, Map<string, number>>;
  readonly messageKeys: Map<string, Map<string, string>>;
  startupSessionRows: SdkSessionRow[] | undefined;
  invalidateBrokerIndexCache(): void;
  readonly windowHostedSessions: Set<string>;
  readonly sessionMetadata: SessionMetadataStore | undefined;
  applyPermissionMode(sessionId: string): Promise<void>;
  readonly emitEvent: (event: AgentEvent) => void;
  readonly attachedSessions: Set<string>;
  startTailFollower(sessionId: string): void;
  refreshSdkCommands(
    sessionId: string,
    advertised?: AgentCommand[],
  ): Promise<void>;
  refreshSessionConfigOptions(sessionId: string): Promise<void>;
  refreshContextUsage(
    sessionId: string,
    options?: { force?: boolean },
  ): Promise<void>;
  locateSharedTranscriptFile(
    sessionId: string,
  ): Promise<string | undefined>;
  watchSharedTranscript(sessionId: string, filePath: string): void;
  ensureAttached(
    sessionId: string,
    replay: boolean,
  ): Promise<void>;
  readonly forkRecoveryIntervalMs: number;
  readonly deletionPromises: Map<string, Promise<void>>;
  readonly deletingSessions: Set<string>;
  readonly workspace: string;
  stopTailFollower(sessionId: string): void;
  removeSessionArtifacts(sessionId: string): Promise<void>;
  /** Runs GJC's interactive `/session delete` on a saved transcript no host holds. */
  deleteThroughGjcCli(cwd: string, sessionPath: string): Promise<void>;
  removeLocalSession(sessionId: string, hide: boolean): void;
  readonly transcriptAttachments: Map<string, Promise<void>>;
  readonly dirtyTranscriptRows: Map<string, Set<string>>;
  readonly desktopTranscriptBaselines: Map<string, TranscriptItem[]>;
  readonly activeAssistantMessages: Map<string, string>;
  readonly activeThoughts: Map<string, string>;
  readonly activePromptSessions: Set<string>;
  readonly activePromptAdmissions: Map<string, symbol>;
  readonly cancellationWatermarks: Map<string, number>;
  readonly liveRunningSessions: Set<string>;
  readonly liveRunningDigests: Map<string, number>;
  readonly liveEvidenceAt: Map<string, number>;
  readonly transcriptRunningSessions: Set<string>;
  readonly workingPhaseSessions: Set<string>;
  readonly runtimeIdleSessions: Set<string>;
  readonly pendingAsyncWorkSessions: Map<string, string[]>;
  readonly completionDeferredSessions: Set<string>;
  readonly asyncJobReconciliations: Map<string, { checkedAt: number; deadJobIds: Set<string>; checkedJobIds: Set<string>; querySucceeded: boolean; }>;
  readonly runRevisions: Map<string, number>;
  readonly discoveredRunStates: Map<string, { size: number; status: AgentSession["status"]; runningJobIds?: string[] }>;
  readonly idleTranscriptBaselines: Map<string, { revision: number; size: number }>;
  readonly compactingSessions: Set<string>;
  readonly compactionRecordBaseline: Map<string, number>;
  readonly compactionRecordWatermark: Map<string, number>;
  readonly compactionStartedAt: Map<string, number>;
  readonly suppressedUserMessageKeys: Map<string, Set<string>>;
  readonly echoedPromptTexts: Map<string, string[]>;
  readonly locallyAbortedSessions: Set<string>;
  readonly sessionCommands: Map<string, AgentCommand[]>;
  readonly publishedCommandKeys: Map<string, string>;
  readonly commandRefreshes: Map<string, Promise<void>>;
  readonly sessionContextRefreshes: Map<string, Promise<void>>;
  readonly sessionContextRefreshedAt: Map<string, number>;
  clearCommandRefreshRetry(sessionId: string): void;
  clearTodoPoll(sessionId: string): void;
  clearProgress(sessionId: string): void;
  readonly sessionAdvertisedCommands: Map<string, AgentCommand[]>;
  readonly sessionDiscoveredCommands: Map<string, AgentCommand[]>;
  readonly sessionPlans: Map<string, PlanActivity>;
  readonly sessionQuestions: Map<string, Map<string, QuestionActivity>>;
  readonly sessionTodoSnapshots: Map<string, TodoSnapshotState>;
  readonly todoReads: Map<string, Promise<unknown[] | undefined>>;
  readonly sessionSdkOperations: Map<string, Set<string>>;
  readonly sessionConfig: Map<string, AgentConfigOption[]>;
  readonly terminalOnlySessions: Set<string>;
  readonly routeProbes: Map<string, { at: number; reachable: boolean }>;
  readonly modelProfiles: Map<string, AgentConfigOptionValue[]>;
  readonly explicitSessionThinking: Map<string, string>;
  readonly sharedSessionWatchers: Map<string, FSWatcher>;
  readonly runStateWatchers: Map<string, FSWatcher>;
  readonly runStateTimers: Map<string, NodeJS.Timeout>;
  readonly sharedSessionRefreshTimers: Map<string, ReturnType<typeof setTimeout>>;
  cancelPermissionsForSession(sessionId: string): void;
  lastLiveFingerprint: string | undefined;
  lastDiscovered: AgentSession[];
  sdkOperations(
    sessionId: string,
    options?: { strict?: boolean },
  ): Promise<Set<string>>;
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
}

export async function createSession(host: LifecycleHost, input: CreateSessionInput): Promise<AgentSession> {
  if (input.runtime !== "gjc")
    throw new Error("The GJC controller only creates GJC sessions");
  const cli = await host.requireCli();
  let sessionWorkspace = canonicalWorkspace(input.workspace);
  let worktree:
    | { sourceWorkspace: string; path: string; branch: string; managed: true }
    | undefined;
  let branchExisted = false;
  if (input.isolation === "worktree") {
    const root = (
      await execFile("git", [
        "-C",
        sessionWorkspace,
        "rev-parse",
        "--show-toplevel",
      ])
    ).stdout.trim();
    if (!root) throw new Error("Workspace is not a git repository");
    const suffix = `${Date.now().toString(36)}-${host.nextLocalId++}`;
    const branch = input.worktreeBranch?.trim() || `gajae/${suffix}`;
    const worktreePath = path.join(
      path.dirname(root),
      `${path.basename(root)}.gajae-worktrees`,
      suffix,
    );
    // An existing branch is checked out rather than recreated: `-b` refuses it,
    // and the failure cleanup below must never delete a branch it did not make.
    branchExisted = await execFile("git", [
      "-C",
      root,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]).then(
      () => true,
      () => false,
    );
    // A named branch someone pushed from another machine is on a remote only.
    // Starting it with `-b` would make a second, unrelated branch of that name,
    // so it is checked out, which makes git track the one remote that has it.
    const onOneRemote =
      !branchExisted &&
      input.worktreeBranch !== undefined &&
      !input.worktreePull &&
      (await remotesWithBranch(root, branch)) === 1;
    if (!branchExisted && input.worktreePull) {
      const { remote, number } = input.worktreePull;
      await execFile("git", [
        "-C",
        root,
        "fetch",
        "--no-tags",
        remote,
        `pull/${number}/head:refs/heads/${branch}`,
      ]).catch((error: unknown) => {
        throw new Error(
          `PR #${number}의 head를 ${remote}에서 받아 오지 못했습니다.`,
          { cause: error },
        );
      });
    }
    try {
      await execFile("git", [
        "-C",
        root,
        "worktree",
        "add",
        ...(branchExisted || onOneRemote || input.worktreeBranchExisting || input.worktreePull
          ? [worktreePath, branch]
          : ["-b", branch, worktreePath]),
      ]);
    } catch (error) {
      // Without a local branch, git checks out the one remote branch of that
      // name. A branch that exists nowhere must not become a new one from HEAD.
      if (input.worktreeBranchExisting && !branchExisted)
        throw new Error(
          `브랜치 ${branch}을(를) 로컬이나 원격에서 찾지 못했습니다. git fetch로 받아 온 뒤 다시 시도하세요.`,
          { cause: error },
        );
      throw error;
    }
    sessionWorkspace = worktreePath;
    worktree = {
      sourceWorkspace: root,
      path: worktreePath,
      branch,
      managed: true,
    };
  }
  const knownSessionIds = new Set([
    ...host.sessions.keys(),
    ...(await host.brokerSessions())?.map((session) => session.sessionId) ??
      [],
  ]);
  let response: { sessionId: string } | undefined;
  const createRequestId = `gajae-session-create-${randomUUID()}`;
  const createStartedAt = Date.now();
  try {
    const created = await cli.rawGlobal(
      "session.create",
      {
        cwd: sessionWorkspace,
        modelPreset: input.modelPreset ?? host.modelPreset,
      },
      { repo: sessionWorkspace, idempotencyKey: createRequestId },
    );
    const sessionId =
      typeof created?.sessionId === "string" ? created.sessionId : undefined;
    if (sessionId) response = { sessionId };
  } catch (error) {
    // A create whose receipt could not be verified may still have produced a live
    // session. Verified against gjc/0.15.6: `session.create` answers
    // `terminal_uncertain` while `list` shows the new session live with a pid, so
    // the index is what settles it. Adopting it is not optimism -- it is reading
    // the authoritative account instead of the unverifiable receipt.
    if (isLifecycleUncertain(error)) {
      const retainedId = await recoverLifecycleSession(host,
        sessionWorkspace,
        knownSessionIds,
        createStartedAt,
      );
      if (retainedId) {
        host.sessionCwds.set(retainedId, sessionWorkspace);
        host.transcripts.set(retainedId, []);
        host.toolRowIndices.delete(retainedId);
        host.messageKeys.set(retainedId, new Map());
        response = { sessionId: retainedId };
      }
    }
    if (!response && worktree && error instanceof SdkCliError && error.outcomeCertainty === "not-applied") {
      try {
        const status = (
          await execFile("git", [
            "-C",
            worktree.path,
            "status",
            "--porcelain",
          ])
        ).stdout.trim();
        if (!status) {
          await execFile("git", [
            "-C",
            worktree.sourceWorkspace,
            "worktree",
            "remove",
            worktree.path,
          ]);
          if (!branchExisted)
            await execFile("git", [
              "-C",
              worktree.sourceWorkspace,
              "branch",
              "-D",
              worktree.branch,
            ]);
        }
      } catch {
        /* Preserve a dirty or otherwise uncertain worktree for manual recovery. */
      }
    }
    if (!response && isLifecycleUncertain(error)) {
      throw new Error(
        "GJC가 세션을 생성했지만 lifecycle 영수증을 검증하지 못했습니다. 보존된 세션 자동 복구에도 실패했습니다. GJC lifecycle ledger reconciliation이 필요합니다.",
      );
    }
    if (!response) throw error;
  }
  if (!response) throw new Error("GJC did not report a new session id");
  // The startup scan predates this mutation and would hide the new session on
  // the first list call, even though create already announced it to the UI.
  host.startupSessionRows = undefined;
  host.invalidateBrokerIndexCache();
  const createdSessionId = response.sessionId;
  const session: AgentSession = {
    id: createdSessionId,
    title: input.title?.trim() || "New Gajae session",
    subtitle: path.basename(sessionWorkspace) || sessionWorkspace,
    workspace: sessionWorkspace,
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    updatedAtMs: Date.now(),
    pinned: false,
    unread: false,
    accent: GJC_ACCENT,
    ownership: "gajae",
    attachment: "recovering",
    ...(worktree ? { worktree } : {}),
    ...(input.workLink ? { workLink: input.workLink } : {}),
  };
  host.sessions.set(session.id, session);
  host.windowHostedSessions.add(session.id);
  host.sessionCwds.set(session.id, sessionWorkspace);
  host.transcripts.set(session.id, []);
  host.toolRowIndices.delete(session.id);
  host.messageKeys.set(session.id, new Map());
  host.sessionMetadata?.setAlias(session.id, session.title);
  host.sessionMetadata?.setWorkspace(session.id, sessionWorkspace);
  host.sessionMetadata?.setOwnership(session.id, "gajae");
  if (worktree) host.sessionMetadata?.setWorktree(session.id, worktree);
  if (input.workLink) host.sessionMetadata?.setWorkLink(session.id, input.workLink);
  try {
    await host.applyPermissionMode(session.id);
  } catch (error) {
    // A session whose safety mode was not confirmed must remain readable but is
    // never advertised as sendable. Preserve its worktree and metadata so the
    // user can retry resume after fixing the broker/runtime failure.
    session.status = "failed";
    session.attachment = "recovering";
    host.emitEvent({ type: "session.created", session: { ...session } });
    throw error;
  }
  session.attachment = "attached";
  host.attachedSessions.add(session.id);
  host.startTailFollower(session.id);
  void host.refreshSdkCommands(session.id);
  await host.refreshSessionConfigOptions(session.id);
  void host.refreshContextUsage(session.id);
  // The new session's file is the live account for everything it does next.
  const createdFile = await host.locateSharedTranscriptFile(session.id);
  if (createdFile) host.watchSharedTranscript(session.id, createdFile);
  host.emitEvent({ type: "session.created", session: { ...session } });
  return { ...session };
}

export async function forkSession(host: LifecycleHost, input: {
  sourceSessionId: string;
  title?: string;
}): Promise<AgentSession> {
  const source = host.sessions.get(input.sourceSessionId);
  if (!source)
    throw new Error(`Unknown GJC session: ${input.sourceSessionId}`);
  const cwd = host.sessionCwds.get(source.id);
  if (!cwd || path.resolve(cwd) !== path.resolve(source.workspace))
    throw new Error("Fork requires the canonical source workspace");
  await host.ensureAttached(source.id, false);
  // The fork itself is what creates the session; the lifecycle receipt is only
  // the evidence that it was recorded. A receipt that cannot be verified was
  // reported as a failed fork even though the broker had already created the
  // session -- which is why discovery listed it moments later. The broker index
  // is the authority on whether that happened, so it is consulted instead of
  // surfacing an error for a fork that succeeded.
  const knownSessionIds = new Set([
    ...host.sessions.keys(),
    ...((await host.brokerSessions()) ?? []).map((listed) => listed.sessionId),
  ]);
  const cli = await host.requireCli();
  let forkedId: string | undefined;
  const forkRequestId = `gajae-session-fork-${randomUUID()}`;
  const forkStartedAt = Date.now();
  try {
    const forked = await cli.rawGlobal(
      "session.fork",
      {
        cwd,
        sourceSessionId: source.id,
        modelPreset: host.modelPreset,
      },
      { repo: cwd, idempotencyKey: forkRequestId },
    );
    if (typeof forked?.sessionId === "string") forkedId = forked.sessionId;
  } catch (error) {
    if (!isLifecycleUncertain(error)) throw error;
  }
  // The fork changes the broker index. A discovery cache taken before it
  // would omit the new session until the index file's revision moved.
  host.invalidateBrokerIndexCache();
  if (!forkedId)
    forkedId = await recoverForkedSession(host,
      cwd,
      knownSessionIds,
      forkStartedAt,
    );
  if (!forkedId)
    throw new Error(
      "GJC가 세션을 포크했지만 lifecycle 영수증을 검증하지 못했습니다. 보존된 포크 자동 복구에도 실패했습니다. GJC lifecycle ledger reconciliation이 필요합니다.",
    );
  const inheritedWorktree =
    source.worktree?.managed === true &&
    path.resolve(source.worktree.path) === path.resolve(cwd)
      ? source.worktree
      : undefined;
  const session: AgentSession = {
    id: forkedId,
    title: input.title?.trim() || `${source.title} (fork)`,
    subtitle: path.basename(cwd) || cwd,
    workspace: cwd,
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    updatedAtMs: Date.now(),
    // The fork this window asked for already knows the source; the envelope read
    // only has to cover sessions this window did not create.
    parentId: input.sourceSessionId,
    pinned: false,
    unread: false,
    accent: GJC_ACCENT,
    ownership: "gajae",
    attachment: "recovering",
    ...(inheritedWorktree ? { worktree: inheritedWorktree } : {}),
  };
  host.sessions.set(session.id, session);
  host.windowHostedSessions.add(session.id);
  host.sessionCwds.set(session.id, cwd);
  host.sessionMetadata?.setAlias(session.id, session.title);
  host.sessionMetadata?.setWorkspace(session.id, cwd);
  host.sessionMetadata?.setOwnership(session.id, "gajae");
  if (inheritedWorktree)
    host.sessionMetadata?.setWorktree(session.id, inheritedWorktree);
  try {
    await host.applyPermissionMode(session.id);
  } catch (error) {
    session.status = "failed";
    host.emitEvent({ type: "session.created", session: { ...session } });
    throw error;
  }
  session.attachment = "attached";
  host.attachedSessions.add(session.id);
  host.startTailFollower(session.id);
  await host.refreshSessionConfigOptions(session.id);
  const forkedFile = await host.locateSharedTranscriptFile(session.id);
  if (forkedFile) host.watchSharedTranscript(session.id, forkedFile);
  host.emitEvent({ type: "session.created", session: { ...session } });
  return { ...session };
}

/**
 * The id of the session a fork created, recovered from the broker index when the
 * fork's own lifecycle receipt could not be verified. Undefined when no new
 * session for this workspace appears, which means the fork really did not happen.
 */
export async function recoverForkedSession(
  host: LifecycleHost,
  cwd: string,
  knownSessionIds: ReadonlySet<string>,
  startedAt: number,
): Promise<string | undefined> {
  const workspace = canonicalWorkspace(cwd);
  const retained = await recoverLifecycleSession(host,
    workspace,
    knownSessionIds,
    startedAt,
    LIFECYCLE_RECOVERY_ATTEMPTS,
    host.forkRecoveryIntervalMs,
  );
  if (retained) {
    host.sessionCwds.set(retained, workspace);
    host.transcripts.set(retained, []);
    host.toolRowIndices.delete(retained);
    host.messageKeys.set(retained, new Map());
  }
  return retained;
}

/**
 * Finds the session a create or fork retained after an unverifiable receipt.
 *
 * GJC's public list/inspect projection strips `lifecycleRequestId` -- the ledger
 * marker is internal -- so matching the caller's idempotency key never succeeds.
 * What the index does establish is that a session is new to this workspace and
 * that its endpoint appeared after the request began. Two such sessions mean a
 * concurrent creator, which is ambiguous; the caller must not guess between them.
 */
async function recoverLifecycleSession(
  host: LifecycleHost,
  workspaceDirectory: string,
  knownSessionIds: ReadonlySet<string>,
  startedAt: number,
  attempts = LIFECYCLE_RECOVERY_ATTEMPTS,
  intervalMs = LIFECYCLE_RECOVERY_INTERVAL_MS,
): Promise<string | undefined> {
  const workspace = canonicalWorkspace(workspaceDirectory);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidates = ((await host.brokerSessions()) ?? []).filter(
      (listed) =>
        !knownSessionIds.has(listed.sessionId) &&
        listed.live &&
        !listed.deleted &&
        (listed.endpointGeneration ?? 0) > 0 &&
        listed.repo !== undefined &&
        canonicalWorkspace(listed.repo) === workspace &&
        Math.max(listed.endpointMtimeMs ?? 0, listed.activityAt ?? 0) >=
          startedAt - LIFECYCLE_RECOVERY_CLOCK_SLACK_MS,
    );
    if (candidates.length > 1) return undefined;
    if (candidates.length === 1) return candidates[0]!.sessionId;
    if (attempt < attempts - 1)
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

export function deleteSession(host: LifecycleHost, sessionId: string): Promise<void> {
  const previous = host.deletionPromises.get(sessionId);
  if (previous) return previous;
  const operation = performDeleteSession(host, sessionId);
  host.deletionPromises.set(sessionId, operation);
  void operation
    .finally(() => {
      if (host.deletionPromises.get(sessionId) === operation)
        host.deletionPromises.delete(sessionId);
    })
    .catch(() => undefined);
  return operation;
}

async function performDeleteSession(host: LifecycleHost, sessionId: string): Promise<void> {
  const session = host.sessions.get(sessionId);
  host.deletingSessions.add(sessionId);
  try {
    // A session this window re-hosted is ours to close; a terminal's host is
    // not. GJC refuses `session.delete` while a host is live, so close only the
    // host this app attached, then delete the saved transcript.
    if (
      host.windowHostedSessions.has(sessionId) &&
      (await sessionBrokerRow(host, sessionId))?.live === true
    ) {
      await brokerLifecycle(host, "session.close", {
        sessionId,
        cwd: host.sessionCwds.get(sessionId) ?? host.workspace,
      });
      host.attachedSessions.delete(sessionId);
      host.stopTailFollower(sessionId);
    }
    let outcome: "deleted" | "recovering";
    try {
      outcome = await brokerLifecycleDelete(host, sessionId);
    } catch (error) {
      // An input refusal is this app's request being wrong, not a fence the CLI
      // should step around.
      if (
        lifecycleInputRefused(error) ||
        (!lifecycleLegacyHistoryAmbiguous(error) &&
          !lifecycleUncertainError(error) &&
          !uncertainLifecycleOutcomeError(error))
      )
        throw error;
      // The outer handler keeps its broker-specific explanation when the CLI
      // cannot take over (no transcript, or a host still holds the session).
      const fallback = await deleteThroughGjcCliFallback(host, sessionId);
      if (fallback === "held") throw new Error(HELD_ELSEWHERE);
      if (fallback === "unavailable") throw error;
      outcome = "deleted";
    }
    if (outcome === "recovering") {
      const fallback = await deleteThroughGjcCliFallback(host, sessionId);
      if (fallback === "held") throw new Error(HELD_ELSEWHERE);
      if (fallback === "deleted") outcome = "deleted";
    }
    if (outcome === "recovering") {
      if (session) {
        session.attachment = "recovering";
        host.attachedSessions.delete(sessionId);
        host.stopTailFollower(sessionId);
        host.emitEvent({ type: "session.updated", session: { ...session } });
      }
      // Who created the session does not decide this: on gjc/0.18.12 a saved
      // session that contains tool execution answers `session.delete` with an
      // unknown outcome while the broker row stays `deleted: false` (upstream
      // #6828), so an app-created session is refused exactly like a CLI's. The
      // old wording sent every caller to a CLI picker and read as "a CLI holds
      // this", which is not the reason here -- the receipt was never conclusive.
      throw new Error("세션 삭제를 확정하지 못했습니다. 로컬 기록과 워크트리는 보존했고, 이 세션은 복구 필요 · 읽기 전용이 되었습니다. GJC가 삭제 결과를 확정하지 못한 경우로, 도구를 실행한 이력이 있는 세션은 gjc/0.18.12에서 삭제가 미확정으로 끝나는 알려진 제한이 있습니다. 삭제를 다시 확인하려면 다시 시도하고, 계속 쓰려면 세션을 이어서 진행하세요. 앱은 삭제를 위해 CLI를 종료하거나 자동으로 재시도하지 않습니다.");
    }
    await host.removeSessionArtifacts(sessionId);
    host.removeLocalSession(sessionId, false);
  } catch (error) {
    if (error instanceof CliDeleteError) {
      if (session) {
        session.attachment = "recovering";
        host.emitEvent({ type: "session.updated", session: { ...session } });
      }
      throw new Error(CLI_DELETE_FAILURES[error.reason]);
    }
    if (lifecycleInputRefused(error) || lifecycleLegacyHistoryAmbiguous(error)) {
      // Neither admission refusal settles earlier effects. Preserve every
      // artifact and require reconciliation before another attempt.
      if (session) {
        session.attachment = "recovering";
        host.attachedSessions.delete(sessionId);
        host.stopTailFollower(sessionId);
        host.emitEvent({ type: "session.updated", session: { ...session } });
      }
      if (lifecycleLegacyHistoryAmbiguous(error)) {
        throw new Error("이전 GJC 수명주기 기록의 영향 범위를 확인할 수 없어 삭제 요청이 실행되지 않았습니다 (lifecycle_legacy_history_ambiguous). 이전 작업의 결과는 여전히 미확정입니다. 원본 작업·요청 키·대상과 ledger를 보존하고 확인해야 합니다. ledger 수정, 강제 삭제, 새 키로 재시도하지 마세요.");
      }
      throw new Error("GJC가 세션 삭제 요청의 입력을 거부했습니다 (lifecycle_input_refused). 요청 정보를 수정하고 기존 세션 상태를 확인해야 합니다. 자동으로 재시도하지 않습니다.");
    }
    if (missingSessionError(error) || missingLifecycleSessionError(error)) {
      await host.removeSessionArtifacts(sessionId);
      host.removeLocalSession(sessionId, false);
      return;
    }
    if (liveSessionDeleteError(error)) {
      throw new Error(HELD_ELSEWHERE);
    }
    if (lifecycleUncertainError(error) || uncertainLifecycleOutcomeError(error)) {
      if (session) {
        session.attachment = "recovering";
        host.attachedSessions.delete(sessionId);
        host.stopTailFollower(sessionId);
        host.emitEvent({ type: "session.updated", session: { ...session } });
      }
      // Same evidence rule as the branch above: the receipt did not establish an
      // outcome and the broker row was never proven gone, so nothing local is
      // discarded and the session stops accepting sends until it is reattached.
      throw new Error("세션 삭제를 확정하지 못했습니다. 로컬 기록과 워크트리는 보존했고, 이 세션은 복구 필요 · 읽기 전용이 되었습니다. 같은 이유로 반복 시도해도 결과가 같을 수 있습니다. 계속 쓰려면 세션을 이어서 진행하세요.");
    }
    throw error;
  } finally {
    host.deletingSessions.delete(sessionId);
  }
}

async function brokerLifecycleDelete(
  host: LifecycleHost,
  sessionId: string,
): Promise<"deleted" | "recovering"> {
  // The shared transcript scan walks this host's session directory and shares no
  // state with the broker, so it runs alongside the lifecycle round trips instead
  // of behind them; the delete still receives the path this lookup resolves on its
  // own.
  const locatedSessionPath = host.locateSharedTranscriptFile(sessionId);
  const row = await sessionBrokerRow(host, sessionId);
  // An unreadable index is not an absent session: with no row there is no evidence
  // that a live endpoint is gone, so the session stays for reconciliation.
  if (row === undefined) return "recovering";
  // Let the SDK authorize this exact saved-session deletion. A live or
  // generation-zero row is neither permission to stop its process nor proof
  // that a future owner-authorized history deletion must be refused locally.
  const cwd = row?.repo ?? host.sessionCwds.get(sessionId) ?? host.workspace;
  const sessionPath = await locatedSessionPath;
  try {
    await brokerLifecycle(host, "session.delete", {
      sessionId,
      cwd,
      ...(row?.stateRoot ? { stateRoot: row.stateRoot } : {}),
      ...(sessionPath ? { sessionPath } : {}),
    });
    return "deleted";
  } catch (error) {
    if (missingLifecycleSessionError(error) || missingSessionError(error))
      return "deleted";
    // A live-session refusal is a definite refusal, not an unknown outcome;
    // the caller must not mark the row recovering when nothing was attempted.
    if (liveSessionDeleteError(error)) throw error;
    if (
      lifecycleUncertainError(error) ||
      uncertainLifecycleOutcomeError(error)
    ) {
      // The receipt is not proof of either success or failure. Only an absent or
      // tombstoned broker row proves deletion; every other outcome preserves the
      // transcript, artifacts, metadata, and worktree for reconciliation.
      const afterDelete = await sessionBrokerRow(host, sessionId);
      if (afterDelete === null || afterDelete?.deleted === true) return "deleted";
      if (lifecycleInputRefused(error) || lifecycleLegacyHistoryAmbiguous(error)) throw error;
      return "recovering";
    }
    throw error;
  }
}

const HELD_ELSEWHERE =
  "이 세션은 다른 터미널의 GJC가 열고 있어 앱에서 지울 수 없습니다. 그 터미널에서 /session delete를 입력해 지우세요. 앱은 기록 삭제를 위해 CLI를 종료하지 않습니다.";

const CLI_DELETE_FAILURES: Record<CliDeleteError["reason"], string> = {
  timeout:
    "GJC CLI의 /session delete가 45초 안에 끝나지 않아 GJC를 종료했습니다. 기록은 그대로 남아 있습니다. 터미널에서 gjc --resume으로 세션을 열고 /session delete를 입력해 지울 수 있습니다.",
  exited:
    "GJC CLI가 세션을 지우기 전에 종료됐습니다. 기록은 그대로 남아 있습니다. 터미널에서 gjc --resume으로 세션을 열고 /session delete를 입력해 지울 수 있습니다.",
  "unexpected-dialog":
    "GJC CLI가 예상하지 못한 확인 창을 띄워 삭제를 멈췄습니다. 기록은 그대로 남아 있습니다. 터미널에서 gjc --resume으로 세션을 열고 /session delete를 입력해 지울 수 있습니다.",
};

/**
 * Deletes a saved session through GJC's interactive `/session delete` after the
 * broker could not.
 *
 * On a machine whose lifecycle ledger holds legacy rows, gjc/0.19.2 refuses every
 * broker delete with `lifecycle_legacy_history_ambiguous` and forbids touching the
 * ledger. The CLI command deletes through GJC's session store and does not go
 * through that fence. It needs the transcript and a session nobody is hosting:
 * `--resume` on a live session would race the host that owns it, and the app
 * never stops a terminal's GJC.
 */
async function deleteThroughGjcCliFallback(
  host: LifecycleHost,
  sessionId: string,
): Promise<"deleted" | "held" | "unavailable"> {
  const row = await sessionBrokerRow(host, sessionId);
  if (!row || row.deleted) return "unavailable";
  if (row.live === true) return "held";
  const sessionPath = await host.locateSharedTranscriptFile(sessionId);
  if (!sessionPath) return "unavailable";
  host.attachedSessions.delete(sessionId);
  host.stopTailFollower(sessionId);
  await host.deleteThroughGjcCli(
    row.repo ?? host.sessionCwds.get(sessionId) ?? host.workspace,
    sessionPath,
  );
  return "deleted";
}

/** `null` means proven absent; `undefined` means the broker index was unavailable. */
async function sessionBrokerRow(
  host: LifecycleHost,
  sessionId: string,
): Promise<SdkSessionRow | null | undefined> {
  const listed = await host.brokerSessions();
  if (!listed) return undefined;
  return listed.find((session) => session.sessionId === sessionId) ?? null;
}

async function brokerLifecycle(
  host: LifecycleHost,
  operation: "session.delete" | "session.close",
  input: Record<string, unknown>,
): Promise<void> {
  const sessionId =
    typeof input.sessionId === "string" ? input.sessionId : undefined;
  const repo =
    (sessionId ? host.sessionCwds.get(sessionId) : undefined) ??
    host.workspace;
  const cli = await host.requireCli();
  await cli.rawGlobal(operation, input, {
    repo,
    idempotencyKey: `gajae-${operation.replace(".", "-")}-${randomUUID()}`,
  });
}

export function removeLocalSession(host: LifecycleHost, sessionId: string, hide: boolean): void {
  host.stopTailFollower(sessionId);
  host.windowHostedSessions.delete(sessionId);
  host.sessions.delete(sessionId);
  host.sessionCwds.delete(sessionId);
  host.attachedSessions.delete(sessionId);
  host.transcriptAttachments.delete(sessionId);
  host.transcripts.delete(sessionId);
  host.toolRowIndices.delete(sessionId);
  host.dirtyTranscriptRows.delete(sessionId);
  host.desktopTranscriptBaselines.delete(sessionId);
  host.messageKeys.delete(sessionId);
  host.activeAssistantMessages.delete(sessionId);
  host.activeThoughts.delete(sessionId);
  host.activePromptSessions.delete(sessionId);
  host.activePromptAdmissions.delete(sessionId);
  host.cancellationWatermarks.delete(sessionId);
  host.liveRunningSessions.delete(sessionId);
  host.liveRunningDigests.delete(sessionId);
  host.liveEvidenceAt.delete(sessionId);
  host.transcriptRunningSessions.delete(sessionId);
  host.workingPhaseSessions.delete(sessionId);
  host.runtimeIdleSessions.delete(sessionId);
  host.pendingAsyncWorkSessions.delete(sessionId);
  host.completionDeferredSessions.delete(sessionId);
  host.asyncJobReconciliations.delete(sessionId);
  host.runRevisions.delete(sessionId);
  host.discoveredRunStates.delete(sessionId);
  host.idleTranscriptBaselines.delete(sessionId);
  host.compactingSessions.delete(sessionId);
  host.compactionRecordBaseline.delete(sessionId);
  host.compactionRecordWatermark.delete(sessionId);
  host.compactionStartedAt.delete(sessionId);
  host.suppressedUserMessageKeys.delete(sessionId);
  host.echoedPromptTexts.delete(sessionId);
  host.locallyAbortedSessions.delete(sessionId);
  host.sessionCommands.delete(sessionId);
  host.publishedCommandKeys.delete(sessionId);
  host.commandRefreshes.delete(sessionId);
  host.sessionContextRefreshes.delete(sessionId);
  host.sessionContextRefreshedAt.delete(sessionId);
  host.clearCommandRefreshRetry(sessionId);
  host.clearTodoPoll(sessionId);
  host.clearProgress(sessionId);
  host.sessionAdvertisedCommands.delete(sessionId);
  host.sessionDiscoveredCommands.delete(sessionId);
  host.sessionPlans.delete(sessionId);
  host.sessionQuestions.delete(sessionId);
  host.sessionTodoSnapshots.delete(sessionId);
  host.todoReads.delete(sessionId);
  host.sessionSdkOperations.delete(sessionId);
  host.sessionConfig.delete(sessionId);
  host.terminalOnlySessions.delete(sessionId);
  host.routeProbes.delete(sessionId);
  host.modelProfiles.delete(sessionId);
  host.explicitSessionThinking.delete(sessionId);
  host.sharedSessionWatchers.get(sessionId)?.close();
  host.sharedSessionWatchers.delete(sessionId);
  host.runStateWatchers.get(sessionId)?.close();
  host.runStateWatchers.delete(sessionId);
  const runStateTimer = host.runStateTimers.get(sessionId);
  if (runStateTimer) clearTimeout(runStateTimer);
  host.runStateTimers.delete(sessionId);
  const refreshTimer = host.sharedSessionRefreshTimers.get(sessionId);
  if (refreshTimer) clearTimeout(refreshTimer);
  host.sharedSessionRefreshTimers.delete(sessionId);
  host.cancelPermissionsForSession(sessionId);
  if (hide) host.sessionMetadata?.hideSession?.(sessionId);
  else host.sessionMetadata?.deleteAlias?.(sessionId);
  // Removing a row changes what the next scan should produce even though the
  // broker's live set is untouched, so the reuse fingerprint is invalidated.
  host.lastLiveFingerprint = undefined;
  host.invalidateBrokerIndexCache();
  host.lastDiscovered = host.lastDiscovered.filter(
    (session) => session.id !== sessionId,
  );
  host.emitEvent({ type: "session.deleted", sessionId });
}

/** Renames through the live SDK, then mirrors the title into app metadata. */
export async function renameSession(host: LifecycleHost, sessionId: string, title: string): Promise<void> {
  const value = title.trim();
  if (!value) throw new Error("Session title cannot be empty");
  const session = host.sessions.get(sessionId);
  if (!session) throw new Error(`Unknown GJC session: ${sessionId}`);
  const operations = await host.sdkOperations(sessionId);
  if (operations.has("session.rename"))
    await host.controlSession(sessionId, "session.rename", { name: value });
  host.sessionMetadata?.setAlias(sessionId, value);
  session.title = value;
  markUpdated(session);
  host.emitEvent({ type: "session.updated", session: { ...session } });
}

/**
 * Stops this window listing a session without touching anything GJC owns.
 *
 * gjc/0.18.12's public `session.delete` cannot remove saved history: it answers
 * `operation_failed` with `outcomeCertainty: unknown` and leaves the broker row
 * at `deleted: false` and the transcript on disk (reproduced on a throwaway
 * session with the exact input this app sends). A delete that cannot be proven is
 * refused, so this is the only removal this build can actually complete. The
 * session id is added to the hidden set discovery filters on, which means it
 * stays out of the rail instead of reappearing on the next scan.
 */
export function hideSession(host: LifecycleHost, sessionId: string): void {
  host.removeLocalSession(sessionId, true);
}
