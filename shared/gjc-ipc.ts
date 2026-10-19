/**
 * The endpoint of the loopback event stream.
 *
 * `port` and `token` are where it listens and the per-process secret that reaches it;
 * `seq` is the event sequence the renderer must read from, so an event published while
 * its window was still loading is replayed by the stream instead of being lost.
 */
export interface GjcEventStreamDescriptor {
  port: number;
  token: string;
  seq: number;
}

export const GJC_IPC = {
  getConnection: "agent-control:gjc:get-connection",
  listSessions: "agent-control:gjc:list-sessions",
  createSession: "agent-control:gjc:create-session",
  forkSession: "agent-control:gjc:fork-session",
  resumeSession: "agent-control:gjc:resume-session",
  listHistorySessions: "agent-control:gjc:list-history-sessions",
  openHistorySession: "agent-control:gjc:open-history-session",
  renameSession: "agent-control:gjc:rename-session",
  deleteSession: "agent-control:gjc:delete-session",
  hideSession: "agent-control:gjc:hide-session",
  getTranscript: "agent-control:gjc:get-transcript",
  getTranscriptRevision: "agent-control:gjc:get-transcript-revision",
  refreshSessionContext: "agent-control:gjc:refresh-session-context",
  setSessionConfig: "agent-control:gjc:set-session-config",
  cycleThinking: "agent-control:gjc:cycle-thinking",
  compactSession: "agent-control:gjc:compact-session",
  queueFollowUp: "agent-control:gjc:queue-follow-up",
  listQueuedMessages: "agent-control:gjc:list-queued-messages",
  flushQueuedNow: "agent-control:gjc:flush-queued-now",
  steerSession: "agent-control:gjc:steer-session",
  sendMessage: "agent-control:gjc:send-message",
  cancelRun: "agent-control:gjc:cancel-run",
  resolveToolCall: "agent-control:gjc:resolve-tool-call",
  markSessionRead: "agent-control:gjc:mark-session-read",
  getDiff: "agent-control:gjc:get-diff",
  readArtifact: "agent-control:gjc:read-artifact",
  previewFile: "agent-control:gjc:preview-file",
  getGoal: "agent-control:gjc:get-goal",
  operateGoal: "agent-control:gjc:operate-goal",
  listSubagents: "agent-control:gjc:list-subagents",
  refreshRuntimeState: "agent-control:gjc:refresh-runtime-state",
  reconnect: "agent-control:gjc:reconnect",
  getGitStatus: "agent-control:gjc:get-git-status",
  stageFiles: "agent-control:gjc:stage-files",
  unstageFiles: "agent-control:gjc:unstage-files",
  commitChanges: "agent-control:gjc:commit-changes",
  pushChanges: "agent-control:gjc:push-changes",
  /**
   * Hands a window this process launched the endpoint of the event stream. The events
   * themselves travel over that stream, never over IPC.
   */
  eventStream: "agent-control:gjc:event-stream",
  // The name desktop events used to travel on. It stays in the channel set because the
  // shared unregister loop and the smoke harnesses iterate over this object and
  // special-case this entry.
  event: "agent-control:gjc:event",
} as const;
