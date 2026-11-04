import type { FSWatcher } from "node:fs";
import type { GjcSdkCli, SdkSessionRow } from "./gjc-sdk-cli.js";
import type { PendingPermission } from "./gjc-sdk-model.js";
import type { PermissionChannels } from "./gjc-sdk-permissions.js";

type Clearable = { clear(): void };

/** The controller members teardown releases when the runtime changes or the controller is disposed. */
export interface TeardownHost {
  readonly acceptedQuestions: Clearable;
  readonly activeAssistantMessages: Clearable;
  readonly activePromptAdmissions: Clearable;
  readonly activePromptSessions: Clearable;
  readonly activeThoughts: Clearable;
  readonly artifactSessionIds: Clearable;
  readonly artifactWrites: Clearable;
  readonly asyncJobReconciliations: Clearable;
  readonly attachAttempts: Clearable;
  readonly attachedSessions: Clearable;
  readonly cancellationPromises: Clearable;
  readonly cancellationWatermarks: Clearable;
  readonly cancellingSessions: Clearable;
  cli: GjcSdkCli | undefined;
  readonly commandRefreshAttempts: Clearable;
  readonly commandRefreshTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly commandRefreshes: Clearable;
  readonly compactingSessions: Clearable;
  readonly compactionRecordBaseline: Clearable;
  readonly compactionRecordWatermark: Clearable;
  readonly compactionStartedAt: Clearable;
  readonly completionDeferredSessions: Clearable;
  readonly contextUsageObservedAt: Clearable;
  readonly contextUsageQueries: Clearable;
  readonly deletingSessions: Clearable;
  readonly deletionPromises: Clearable;
  readonly desktopTranscriptBaselines: Clearable;
  readonly detachTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly dirtyTranscriptRows: Clearable;
  readonly discoveredRunStates: Clearable;
  readonly echoedPromptTexts: Clearable;
  readonly explicitSessionThinking: Clearable;
  readonly flushingSessions: Clearable;
  readonly historySummaryCache: Clearable;
  readonly idleTranscriptBaselines: Clearable;
  readonly imageDataUrls: Clearable;
  invalidateBrokerIndexCache(): void;
  readonly liveEvidenceAt: Clearable;
  readonly liveRunningDigests: Clearable;
  readonly liveRunningSessions: Clearable;
  readonly locallyAbortedSessions: Clearable;
  readonly messageKeys: Clearable;
  readonly modelProfiles: Clearable;
  readonly observedQuestions: Clearable;
  readonly pendingAsyncWorkSessions: Clearable;
  readonly pendingPermissions: Map<string, PendingPermission>;
  readonly pendingSteers: Clearable;
  readonly permissionChannels: PermissionChannels;
  readonly permissionModeApplied: Clearable;
  readonly progressReads: Clearable;
  readonly progressTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly progressWatchedAt: Clearable;
  readonly publishedCommandKeys: Clearable;
  readonly questionAnswers: Clearable;
  readonly questionRefreshes: Clearable;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  readonly routeProbes: Clearable;
  readonly runRevisions: Clearable;
  readonly runStateTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly runStateWatchers: Map<string, FSWatcher>;
  readonly runtimeIdleSessions: Clearable;
  readonly sessionAdvertisedCommands: Clearable;
  readonly sessionCommands: Clearable;
  readonly sessionConfig: Clearable;
  readonly sessionContextRefreshedAt: Clearable;
  readonly sessionContextRefreshes: Clearable;
  readonly sessionCwds: Clearable;
  readonly sessionDiscoveredCommands: Clearable;
  readonly sessionParents: Clearable;
  readonly sessionPlans: Clearable;
  readonly sessionProgress: Clearable;
  readonly sessionQuestions: Clearable;
  readonly sessionSdkOperations: Clearable;
  readonly sessionTodoSnapshots: Clearable;
  readonly sessions: Clearable;
  readonly sharedSessionFiles: Clearable;
  readonly sharedSessionRefreshTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly sharedSessionWatchers: Map<string, FSWatcher>;
  readonly sharedTranscriptReads: Clearable;
  startup: Promise<void> | undefined;
  startupSessionRows: SdkSessionRow[] | undefined;
  stopTailFollower(sessionId: string): void;
  readonly suppressedUserMessageKeys: Clearable;
  readonly tailCheckpoints: Clearable;
  readonly tailControllers: Map<string, AbortController>;
  readonly tailEventPositions: Clearable;
  readonly tailReads: Clearable;
  readonly terminalOnlySessions: Clearable;
  readonly todoPollAttempts: Clearable;
  readonly todoPollTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly todoReads: Clearable;
  readonly toolObservers: Map<string, AbortController>;
  readonly toolRowIndices: Clearable;
  readonly toolSnapshots: Clearable;
  readonly transcriptAttachments: Clearable;
  readonly transcriptEpoch: Clearable;
  readonly transcriptRunningSessions: Clearable;
  readonly transcripts: Clearable;
  watchedTranscripts: Set<string> | undefined;
  readonly windowHostedSessions: Clearable;
  readonly workingPhaseSessions: Clearable;
}

export function disposeController(host: TeardownHost): void {
  for (const pending of host.pendingPermissions.values()) {
    pending.resolve({ outcome: { outcome: "cancelled" } });
  }
  host.pendingPermissions.clear();
  host.permissionChannels.dispose();
  host.routeProbes.clear();
  if (host.reconnectTimer) clearTimeout(host.reconnectTimer);
  host.reconnectTimer = undefined;
  // No agent process is owned here, so disposal never kills a running session.
  for (const controller of host.tailControllers.values()) controller.abort();
  host.tailControllers.clear();
  for (const observer of host.toolObservers.values()) observer.abort();
  host.toolObservers.clear();
  host.toolSnapshots.clear();
  host.cli = undefined;
  host.startup = undefined;
  host.startupSessionRows = undefined;
  host.invalidateBrokerIndexCache();
  for (const timer of host.commandRefreshTimers.values()) clearTimeout(timer);
  host.commandRefreshTimers.clear();
  host.commandRefreshAttempts.clear();
  for (const timer of host.todoPollTimers.values()) clearTimeout(timer);
  host.todoPollTimers.clear();
  host.todoPollAttempts.clear();
  for (const timer of host.progressTimers.values()) clearTimeout(timer);
  host.progressTimers.clear();
  host.sessionProgress.clear();
  host.progressReads.clear();
  host.progressWatchedAt.clear();
  host.publishedCommandKeys.clear();
  host.transcriptAttachments.clear();
  host.permissionModeApplied.clear();
  host.windowHostedSessions.clear();
  host.tailReads.clear();
  host.tailCheckpoints.clear();
  host.tailEventPositions.clear();
  host.sessions.clear();
  host.sessionCwds.clear();
  host.attachedSessions.clear();
  // Only a successful attach removes a session's throttle stamp, so sessions that
  // never attach -- terminal-only rows, dead endpoints -- held one for the life of
  // the process while every other map here was already being cleared.
  host.attachAttempts.clear();
  // Each entry holds a transcript's parsed envelopes, measured at 6.3MB apiece.
  host.sharedTranscriptReads.clear();
  host.sharedSessionFiles.clear();
  host.sessionParents.clear();
  host.historySummaryCache.clear();
  for (const timer of host.detachTimers.values()) clearTimeout(timer);
  host.detachTimers.clear();
  host.watchedTranscripts = undefined;
  host.transcripts.clear();
  host.toolRowIndices.clear();
  host.dirtyTranscriptRows.clear();
  host.desktopTranscriptBaselines.clear();
  host.messageKeys.clear();
  host.activeAssistantMessages.clear();
  host.activeThoughts.clear();
  host.activePromptSessions.clear();
  host.activePromptAdmissions.clear();
  host.cancellationWatermarks.clear();
  host.liveRunningSessions.clear();
  host.liveRunningDigests.clear();
  host.liveEvidenceAt.clear();
  host.transcriptRunningSessions.clear();
  host.workingPhaseSessions.clear();
  host.runtimeIdleSessions.clear();
  host.pendingAsyncWorkSessions.clear();
  host.completionDeferredSessions.clear();
  host.asyncJobReconciliations.clear();
  host.runRevisions.clear();
  host.transcriptEpoch.clear();
  host.discoveredRunStates.clear();
  host.idleTranscriptBaselines.clear();
  host.compactingSessions.clear();
  host.compactionRecordBaseline.clear();
  host.compactionRecordWatermark.clear();
  host.compactionStartedAt.clear();
  host.suppressedUserMessageKeys.clear();
  host.echoedPromptTexts.clear();
  host.sessionCommands.clear();
  host.commandRefreshes.clear();
  host.sessionContextRefreshes.clear();
  host.sessionContextRefreshedAt.clear();
  host.sessionAdvertisedCommands.clear();
  host.sessionDiscoveredCommands.clear();
  host.sessionPlans.clear();
  host.sessionQuestions.clear();
  host.acceptedQuestions.clear();
  host.observedQuestions.clear();
  host.questionRefreshes.clear();
  host.questionAnswers.clear();
  host.sessionTodoSnapshots.clear();
  host.todoReads.clear();
  host.sessionSdkOperations.clear();
  host.sessionConfig.clear();
  host.terminalOnlySessions.clear();
  host.modelProfiles.clear();
  host.explicitSessionThinking.clear();
  host.artifactWrites.clear();
  host.artifactSessionIds.clear();
  host.deletingSessions.clear();
  host.deletionPromises.clear();
  // In-flight bookkeeping. Each entry is normally removed in a `finally`, so what
  // is left here is whatever a rejected or abandoned call did not reach. Teardown
  // claims to release everything, so it has to include these too.
  host.cancellingSessions.clear();
  host.cancellationPromises.clear();
  host.flushingSessions.clear();
  host.pendingSteers.clear();
  host.locallyAbortedSessions.clear();
  host.imageDataUrls.clear();
  host.contextUsageQueries.clear();
  host.contextUsageObservedAt.clear();
  for (const watcher of host.sharedSessionWatchers.values()) watcher.close();
  for (const watcher of host.runStateWatchers.values()) watcher.close();
  host.runStateWatchers.clear();
  for (const timer of host.runStateTimers.values()) clearTimeout(timer);
  host.runStateTimers.clear();
  for (const timer of host.sharedSessionRefreshTimers.values())
    clearTimeout(timer);
  host.sharedSessionWatchers.clear();
  host.sharedSessionRefreshTimers.clear();
}

export function resetForRuntimeChange(host: TeardownHost): void {
  for (const pending of host.pendingPermissions.values())
    pending.resolve({ outcome: { outcome: "cancelled" } });
  host.pendingPermissions.clear();
  host.permissionChannels.dispose();
  // No resident process to stop: dropping the client is the whole teardown, and
  // the next call rebuilds it against the new runtime.
  host.cli = undefined;
  host.startup = undefined;
  host.routeProbes.clear();
  host.permissionModeApplied.clear();
  for (const sessionId of host.toolObservers.keys())
    host.stopTailFollower(sessionId);
  for (const sessionId of host.tailControllers.keys())
    host.stopTailFollower(sessionId);
  host.attachedSessions.clear();
  host.windowHostedSessions.clear();
  // The new runtime re-attaches from scratch, so last run's throttle stamps must
  // not delay the first attempt against it.
  host.attachAttempts.clear();
  host.transcriptAttachments.clear();
  host.activePromptSessions.clear();
  host.activePromptAdmissions.clear();
  host.cancellationWatermarks.clear();
  host.liveRunningSessions.clear();
  host.liveRunningDigests.clear();
  host.liveEvidenceAt.clear();
  host.transcriptRunningSessions.clear();
  host.workingPhaseSessions.clear();
  host.runtimeIdleSessions.clear();
  host.pendingAsyncWorkSessions.clear();
  host.completionDeferredSessions.clear();
  host.asyncJobReconciliations.clear();
  host.discoveredRunStates.clear();
  host.idleTranscriptBaselines.clear();
  host.compactingSessions.clear();
  host.compactionRecordBaseline.clear();
  host.compactionRecordWatermark.clear();
  host.compactionStartedAt.clear();
  host.activeAssistantMessages.clear();
  host.activeThoughts.clear();
  host.suppressedUserMessageKeys.clear();
  host.echoedPromptTexts.clear();
  host.sessionSdkOperations.clear();
}

export function resetForReconnect(host: TeardownHost): void {
  // Reconnect is a re-resolve, not a restart: there is no process to signal, so
  // nothing owned by another window can be disturbed by it.
  host.cli = undefined;
  host.startup = undefined;
  host.desktopTranscriptBaselines.clear();
  host.routeProbes.clear();
  host.permissionModeApplied.clear();
  host.permissionChannels.dispose();
  for (const sessionId of host.toolObservers.keys())
    host.stopTailFollower(sessionId);
  for (const sessionId of host.tailControllers.keys())
    host.stopTailFollower(sessionId);
  host.attachedSessions.clear();
  host.sessionSdkOperations.clear();
  host.transcriptAttachments.clear();
  host.attachAttempts.clear();
}
