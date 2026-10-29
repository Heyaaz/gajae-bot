import { useCallback } from "react";
import type { MutableRefObject } from "react";
import type { AgentSession } from "../backend/types";
import type { NewSessionInput } from "./dialogs";

export interface ComposerActions {
  cancelRun: (sessionId: string) => Promise<void>;
  flushQueuedNow: (sessionId: string) => Promise<void>;
  compactSession: (sessionId: string) => Promise<void>;
  createSession: (input: NewSessionInput) => void | Promise<void>;
  setSessionConfig: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<void>;
  cycleThinking: (sessionId: string) => Promise<void>;
  session: AgentSession | null;
}

export function useComposerCallbacks(
  composerActionsRef: MutableRefObject<ComposerActions>,
) {
  const onComposerCancel = useCallback(() => {
    const session = composerActionsRef.current.session;
    if (!session) return Promise.resolve();
    return composerActionsRef.current.cancelRun(session.id);
  }, []);
  const onComposerFlushQueued = useCallback(() => {
    const session = composerActionsRef.current.session;
    if (!session) return Promise.resolve();
    return composerActionsRef.current.flushQueuedNow(session.id);
  }, []);
  const onComposerCompact = useCallback(() => {
    const session = composerActionsRef.current.session;
    if (!session) return;
    void composerActionsRef.current.compactSession(session.id);
  }, []);
  const onComposerNewSession = useCallback(() => {
    const session = composerActionsRef.current.session;
    if (!session) return;
    composerActionsRef.current.createSession({
      title: "새 Gajae 세션",
      workspace: session.workspace,
    });
  }, []);
  const onComposerWorkspaceChange = useCallback((workspace: string) => {
    composerActionsRef.current.createSession({
      title: "새 Gajae 세션",
      workspace,
    });
  }, []);
  const onComposerConfigChange = useCallback((configId: string, value: string) => {
    const session = composerActionsRef.current.session;
    if (!session) return;
    void composerActionsRef.current.setSessionConfig(session.id, configId, value);
  }, []);
  const onComposerCycleThinking = useCallback(() => {
    const session = composerActionsRef.current.session;
    if (!session) return;
    void composerActionsRef.current.cycleThinking(session.id);
  }, []);

  return {
    onComposerCancel,
    onComposerFlushQueued,
    onComposerCompact,
    onComposerNewSession,
    onComposerWorkspaceChange,
    onComposerConfigChange,
    onComposerCycleThinking,
  };
}
