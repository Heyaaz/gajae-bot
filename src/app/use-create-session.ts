import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AgentSession, TranscriptItem } from "../backend/types";
import type { AgentBackend } from "../backend/agent-backend";
import type { NewSessionPrefill } from "../../shared/settings-ipc";
import { cacheTranscript } from "../transcript-utils";
import { prefillComposerDraft } from "./composer";
import type { NewSessionInput } from "./dialogs";
import { directoryName, humanErrorMessage } from "./format";

export function useCreateSession(
  backend: AgentBackend,
  pendingSessions: MutableRefObject<Map<string, Promise<AgentSession>>>,
  setAppError: (message: string) => void,
  setNewSessionRequest: Dispatch<
    SetStateAction<{ prefill?: NewSessionPrefill; serial: number } | null>
  >,
  setSessions: Dispatch<SetStateAction<AgentSession[]>>,
  setSelectedId: Dispatch<SetStateAction<string | null>>,
  setTranscripts: Dispatch<SetStateAction<Record<string, TranscriptItem[]>>>,
) {
  const createSession = useCallback(
    (input: NewSessionInput): void | Promise<void> => {
      if (input.kind === "terminal") {
        setAppError("");
        return backend
          .createSession({
            runtime: "terminal",
            title: input.title,
            workspace: input.workspace,
            isolation: "workspace",
          })
          .then((session) => {
            setSessions((current) => [
              session,
              ...current.filter((item) => item.id !== session.id),
            ]);
            setSelectedId(session.id);
            setNewSessionRequest(null);
          })
          .catch((error: unknown) => {
            throw new Error(humanErrorMessage(error));
          });
      }
      const draftId = `draft-${crypto.randomUUID()}`;
      const draft: AgentSession = {
        id: draftId,
        title: input.title,
        subtitle: directoryName(input.workspace),
        workspace: input.workspace,
        runtime: "gjc",
        status: "starting",
        updatedAt: "now",
        updatedAtMs: Date.now(),
        pinned: false,
        unread: false,
        accent: "#ff8a34",
        ownership: "gajae",
        attachment: "attached",
      };
      setSessions((current) => [draft, ...current]);
      setSelectedId(draftId);
      setTranscripts((current) => cacheTranscript(current, draftId, []));
      setNewSessionRequest(null);
      setAppError("");

      const creation = backend.createSession({
        runtime: "gjc",
        title: input.title,
        workspace: input.workspace,
        isolation: input.isolation ?? "workspace",
        worktreeBranch: input.worktreeBranch,
        ...(input.worktreeBranchExisting ? { worktreeBranchExisting: true } : {}),
        ...(input.worktreePull ? { worktreePull: input.worktreePull } : {}),
        ...(input.workLink ? { workLink: input.workLink } : {}),
      });
      pendingSessions.current.set(draftId, creation);
      void creation
        .then((session) => {
          // Only the real id outlives this draft, so the prompt waits for it.
          // It is never sent from here: the user reads it and presses send.
          if (input.initialPrompt || input.initialImages)
            prefillComposerDraft(
              session.id,
              input.initialPrompt ?? "",
              input.initialImages,
            );
          setSessions((current) => [
            session,
            ...current.filter(
              (item) => item.id !== draftId && item.id !== session.id,
            ),
          ]);
          setSelectedId((current) =>
            current === draftId ? session.id : current,
          );
          setTranscripts((current) => {
            const next = { ...current };
            const items = current[session.id] ?? current[draftId] ?? [];
            delete next[draftId];
            return cacheTranscript(next, session.id, items);
          });
        })
        .catch((error) => {
          setSessions((current) =>
            current.map((session) =>
              session.id === draftId
                ? { ...session, status: "failed" }
                : session,
            ),
          );
          setAppError(humanErrorMessage(error));
        });
    },
    [backend],
  );

  return createSession;
}
