import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";

export function useSessionRemoval(
  backend: AgentBackend,
  sessions: AgentSession[],
  selectedId: string | null,
  forgetSession: (sessionId: string) => void,
  resolveSessionId: (sessionId: string) => Promise<string>,
  setSessions: Dispatch<SetStateAction<AgentSession[]>>,
  setSelectedId: Dispatch<SetStateAction<string | null>>,
  setDeleteCandidate: Dispatch<SetStateAction<AgentSession | null>>,
  setAppError: (message: string) => void,
) {
  /**
   * Hides a session from the rail without deleting anything GJC owns.
   *
   * gjc/0.18.12 cannot complete a saved-history delete through the public SDK
   * (session.delete answers operation_failed with an unknown outcome and leaves
   * the row and transcript in place), so this is the only removal that finishes.
   * It is offered as its own action; the delete path above stays as it was.
   */
  const hideSession = useCallback((sessionId: string): void => {
    const removed = sessions.find((candidate) => candidate.id === sessionId);
    forgetSession(sessionId);
    void backend.hideSession(sessionId).catch((error: unknown) => {
      // Hiding is local bookkeeping, so a failure leaves the rail unchanged and
      // reports why instead of pretending the row went away.
      if (removed)
        setSessions((current) =>
          current.some((session) => session.id === removed.id)
            ? current
            : [removed, ...current],
        );
      setAppError(error instanceof Error ? error.message : String(error));
    });
  }, [backend, forgetSession, sessions]);

  const onHideSession = useCallback(
    (session: AgentSession) => {
      hideSession(session.id);
    },
    [hideSession],
  );

  async function deleteSession(sessionId: string): Promise<void> {
    // The user is the first to know: the backend's delete walks close, broker
    // lookup and delete one CLI call at a time, and the row used to sit in the
    // sidebar for all of it. Drop the row now, keep the copies needed to take it
    // back, and let the `session.deleted` event that follows be a no-op.
    const removed = sessions.find((session) => session.id === sessionId) ?? null;
    const selectionBefore = selectedId;
    // What dropping the selected row will move the selection to; the delete only
    // restores the old selection if it is still on this spot when the backend says
    // no, so a selection the user made meanwhile stands.
    const selectionAfter =
      selectionBefore === sessionId
        ? (sessions.find((session) => session.id !== sessionId)?.id ?? null)
        : selectionBefore;
    forgetSession(sessionId);
    setDeleteCandidate(null);
    try {
      await backend.deleteSession(await resolveSessionId(sessionId));
    } catch (error) {
      // The row never really left. Put it back -- unless it reappeared on its own
      // while the backend worked -- and undo the selection move this delete made.
      if (removed) {
        setSessions((current) =>
          current.some((session) => session.id === removed.id)
            ? current
            : [removed, ...current],
        );
      }
      setSelectedId((current) =>
        current === selectionAfter ? selectionBefore : current,
      );
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  return { onHideSession, deleteSession };
}
