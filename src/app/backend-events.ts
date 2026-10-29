import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AgentCommand, AgentConfigOption, AgentEvent, AgentSession, BackendConnection, TranscriptItem } from "../backend/types";
import type { MessageDeliveryTracker } from "../message-delivery";
import { discoveryRevisionIsFresh, cacheTranscript, updateTranscriptItem } from "../transcript-utils";
import { mergeTranscriptTail } from "../transcript-pages";
import type { SessionTranscriptPageState } from "./shell-model";

export interface BackendEventContext {
  setConnection: Dispatch<SetStateAction<BackendConnection>>;
  setSessions: Dispatch<SetStateAction<AgentSession[]>>;
  setTranscripts: Dispatch<SetStateAction<Record<string, TranscriptItem[]>>>;
  setCommands: Dispatch<SetStateAction<Record<string, AgentCommand[]>>>;
  setConfigOptions: Dispatch<SetStateAction<Record<string, AgentConfigOption[]>>>;
  setMessageDeliveryRevision: Dispatch<SetStateAction<number>>;
  messageDeliveryTrackerRef: MutableRefObject<MessageDeliveryTracker | null>;
  transcriptsRef: MutableRefObject<Record<string, TranscriptItem[]>>;
  transcriptPageStatesRef: MutableRefObject<Record<string, SessionTranscriptPageState>>;
  transcriptRevisionsRef: MutableRefObject<Map<string, string>>;
  selectedIdRef: MutableRefObject<string | null>;
  observeSessionRun: (session: AgentSession) => void;
  forgetSession: (sessionId: string) => void;
  tracksTranscriptSession: (sessionId: string) => boolean;
  noteTranscriptEvent: (sessionId: string, itemIds?: string[]) => void;
  updateRequestSummaries: (sessionId: string, items: readonly TranscriptItem[]) => void;
  mergeLiveTranscriptItems: (
    sessionId: string,
    current: TranscriptItem[],
    incoming: readonly TranscriptItem[],
  ) => TranscriptItem[];
  refreshTranscript: (id: string) => void;
}

export function createBackendEventHandler(
  context: BackendEventContext,
): (event: AgentEvent) => void {
  const {
    setConnection,
    setSessions,
    setTranscripts,
    setCommands,
    setConfigOptions,
    setMessageDeliveryRevision,
    messageDeliveryTrackerRef,
    transcriptsRef,
    transcriptPageStatesRef,
    transcriptRevisionsRef,
    selectedIdRef,
    observeSessionRun,
    forgetSession,
    tracksTranscriptSession,
    noteTranscriptEvent,
    updateRequestSummaries,
    mergeLiveTranscriptItems,
    refreshTranscript,
  } = context;
  return (event: AgentEvent) => {
    if (event.type === "connection.updated") {
      setConnection(event.connection);
    } else if (event.type === "session.created") {
      observeSessionRun(event.session);
      setSessions((current) => [
        event.session,
        ...current.filter((session) => session.id !== event.session.id),
      ]);
    } else if (event.type === "session.updated") {
      observeSessionRun(event.session);
      setSessions((current) =>
        current.map((session) =>
          session.id === event.session.id &&
          discoveryRevisionIsFresh(
            session.runRevision,
            event.session.runRevision,
          )
            ? event.session
            : session,
        ),
      );
    } else if (event.type === "session.deleted") {
      forgetSession(event.sessionId);
    } else if (event.type === "transcript.appended") {
      const tracked = tracksTranscriptSession(event.item.sessionId);
      if (tracked) noteTranscriptEvent(event.item.sessionId, [event.item.id]);
      messageDeliveryTrackerRef.current!.observeUserEvent(
        event.item.sessionId,
        event.item,
        Date.now(),
      );
      setMessageDeliveryRevision((revision) => revision + 1);
      if (tracked && !event.item.id.startsWith("local-prompt-"))
        updateRequestSummaries(event.item.sessionId, [event.item]);
      setTranscripts((current) => {
        const items = current[event.item.sessionId];
        if (!items) return current;
        const next = cacheTranscript(
          current,
          event.item.sessionId,
          mergeLiveTranscriptItems(event.item.sessionId, items, [event.item]),
        );
        transcriptsRef.current = next;
        return next;
      });
    } else if (event.type === "transcript.synced") {
      const tracked = tracksTranscriptSession(event.sessionId);
      if (tracked)
        noteTranscriptEvent(event.sessionId, event.items.map((item) => item.id));
      messageDeliveryTrackerRef.current!.observeTranscript(
        event.sessionId,
        event.items,
        { kind: "other", complete: false },
        Date.now(),
      );
      setMessageDeliveryRevision((revision) => revision + 1);
      if (tracked)
        updateRequestSummaries(
          event.sessionId,
          event.items.filter(
            (item) =>
              item.kind !== "message" ||
              item.role !== "user" ||
              !item.id.startsWith("local-prompt-"),
          ),
        );
      setTranscripts((current) => {
        const existing = current[event.sessionId];
        if (!existing) return current;
        const pageState = transcriptPageStatesRef.current[event.sessionId];
        const historical = pageState?.scope.kind === "around" || pageState?.hasMoreAfter;
        const items = historical
          ? mergeLiveTranscriptItems(
              event.sessionId,
              existing,
              event.items.filter((item) => existing.some((row) => row.id === item.id)),
            )
          : mergeTranscriptTail(existing, event.items);
        const next = cacheTranscript(current, event.sessionId, items);
        transcriptsRef.current = next;
        return next;
      });
    } else if (event.type === "transcript.invalidated") {
      transcriptRevisionsRef.current.delete(event.sessionId);
      if (tracksTranscriptSession(event.sessionId))
        noteTranscriptEvent(event.sessionId);
      refreshTranscript(event.sessionId);
    } else if (event.type === "message.delta") {
      if (tracksTranscriptSession(event.sessionId))
        noteTranscriptEvent(event.sessionId, [event.messageId]);
      setTranscripts((current) => {
        const next = updateTranscriptItem(
          current,
          event.sessionId,
          event.messageId,
          (item) =>
            item.kind === "message"
              ? {
                  ...item,
                  content: item.content + event.delta,
                  streaming: event.streaming,
                }
              : item,
        );
        transcriptsRef.current = next;
        return next;
      });
    } else if (event.type === "message.updated") {
      const tracked = tracksTranscriptSession(event.message.sessionId);
      if (tracked)
        noteTranscriptEvent(event.message.sessionId, [event.message.id]);
      messageDeliveryTrackerRef.current!.observeUserEvent(
        event.message.sessionId,
        event.message,
        Date.now(),
      );
      setMessageDeliveryRevision((revision) => revision + 1);
      if (tracked && !event.message.id.startsWith("local-prompt-"))
        updateRequestSummaries(event.message.sessionId, [event.message]);
      setTranscripts((current) => {
        const next = updateTranscriptItem(
          current,
          event.message.sessionId,
          event.message.id,
          () => event.message,
        );
        transcriptsRef.current = next;
        return next;
      });
    } else if (event.type === "thought.delta") {
      if (tracksTranscriptSession(event.sessionId))
        noteTranscriptEvent(event.sessionId, [event.thoughtId]);
      setTranscripts((current) => {
        const next = updateTranscriptItem(
          current,
          event.sessionId,
          event.thoughtId,
          (item) =>
            item.kind === "thought"
              ? {
                  ...item,
                  content: item.content + event.delta,
                  streaming: event.streaming,
                }
              : item,
        );
        transcriptsRef.current = next;
        return next;
      });
    } else if (event.type === "plan.updated") {
      if (tracksTranscriptSession(event.plan.sessionId))
        noteTranscriptEvent(event.plan.sessionId, [event.plan.id]);
      setTranscripts((current) => {
        const next = updateTranscriptItem(
          current,
          event.plan.sessionId,
          event.plan.id,
          () => event.plan,
        );
        transcriptsRef.current = next;
        return next;
      });
    } else if (event.type === "session.commands") {
      setCommands((current) => ({
        ...current,
        [event.sessionId]: event.commands,
      }));
    } else if (event.type === "session.config") {
      setConfigOptions((current) => ({
        ...current,
        [event.sessionId]: event.options,
      }));
    } else if (event.type === "tool.updated") {
      if (tracksTranscriptSession(event.tool.sessionId))
        noteTranscriptEvent(event.tool.sessionId, [event.tool.id]);
      setTranscripts((current) => {
        const next = updateTranscriptItem(
          current,
          event.tool.sessionId,
          event.tool.id,
          () => event.tool,
        );
        transcriptsRef.current = next;
        return next;
      });
    } else if (event.type === "question.updated") {
      const tracked = tracksTranscriptSession(event.question.sessionId);
      if (tracked)
        noteTranscriptEvent(event.question.sessionId, [event.question.id]);
      setTranscripts((current) => {
        const items = current[event.question.sessionId];
        if (!items) return current;
        const next = cacheTranscript(
          current,
          event.question.sessionId,
          mergeLiveTranscriptItems(
            event.question.sessionId,
            items,
            [event.question],
          ),
        );
        transcriptsRef.current = next;
        return next;
      });
    } else if (event.type === "session.activity") {
      setSessions((current) =>
        current.map((s) =>
          s.id === event.sessionId
            ? {
                ...s,
                unread:
                  event.sessionId !== selectedIdRef.current && event.unread,
              }
            : s,
        ),
      );
    }
  };
}
