import { useEffect, useRef, useState } from "react";
import type { AgentSession, BackendConnection } from "../backend/types";
import type { AgentBackend } from "../backend/agent-backend";
import { MessageDeliveryTracker } from "../message-delivery";
import { mergeTranscriptPage } from "../transcript-pages";
import { deliverySessionState } from "./shell-model";

export function useMessageDelivery(
  backend: AgentBackend,
  sessions: AgentSession[],
  connection: BackendConnection,
) {
  const messageDeliveryTrackerRef = useRef<MessageDeliveryTracker | null>(null);
  if (!messageDeliveryTrackerRef.current)
    messageDeliveryTrackerRef.current = new MessageDeliveryTracker();
  const deliveryPageReadsRef = useRef(new Set<string>());
  const deliveryPageRetryAfterRef = useRef(new Map<string, number>());
  const deliveryRetryTimersRef = useRef(new Map<string, number>());
  const [messageDeliveryRevision, setMessageDeliveryRevision] = useState(0);

  useEffect(() => {
    const tracker = messageDeliveryTrackerRef.current!;
    const now = Date.now();
    for (const sessionId of tracker.sessionIds()) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      const deliveryState = deliverySessionState(
        session,
        connection.state,
      );
      tracker.observeSession(
        sessionId,
        deliveryState,
        now,
      );
      if (
        tracker.needsLatestRead(sessionId) &&
        !deliveryPageReadsRef.current.has(sessionId) &&
        Date.now() >= (deliveryPageRetryAfterRef.current.get(sessionId) ?? 0)
      ) {
        deliveryPageReadsRef.current.add(sessionId);
        const requestedAt = Date.now();
        const beforeCount = tracker.snapshot(sessionId).length;
        void (async () => {
          let latest = await backend.getTranscriptPage(sessionId);
          const latestHasMoreAfter = latest.hasMoreAfter;
          let items = latest.items;
          let hasMoreBefore = latest.hasMoreBefore;
          let covered = tracker.coversPendingAttempts(
            sessionId,
            items,
            hasMoreBefore,
          );
          while (!latestHasMoreAfter && !covered && hasMoreBefore && latest.firstId) {
            const older = await backend.getTranscriptPage(sessionId, {
              beforeId: latest.firstId,
            });
            items = mergeTranscriptPage(items, older, "prepend");
            latest = {
              ...latest,
              firstId: older.firstId,
              lastId: latest.lastId,
              hasMoreBefore: older.hasMoreBefore,
              items,
            };
            hasMoreBefore = older.hasMoreBefore;
            covered = tracker.coversPendingAttempts(
              sessionId,
              items,
              hasMoreBefore,
            );
          }
          const complete = !latestHasMoreAfter && covered;
          tracker.observeTranscript(
            sessionId,
            items,
            { kind: "latest", complete, requestedAt },
            Date.now(),
          );
          const afterCount = tracker.snapshot(sessionId).length;
          const needsAnotherRead = tracker.needsLatestRead(sessionId);
          if ((complete || afterCount !== beforeCount) && !needsAnotherRead) {
            deliveryPageRetryAfterRef.current.delete(sessionId);
            const timer = deliveryRetryTimersRef.current.get(sessionId);
            if (timer !== undefined) window.clearTimeout(timer);
            deliveryRetryTimersRef.current.delete(sessionId);
            setMessageDeliveryRevision((revision) => revision + 1);
          } else {
            const retryAt = Date.now() + 5_000;
            deliveryPageRetryAfterRef.current.set(sessionId, retryAt);
            if (!deliveryRetryTimersRef.current.has(sessionId)) {
              const timer = window.setTimeout(() => {
                deliveryRetryTimersRef.current.delete(sessionId);
                deliveryPageRetryAfterRef.current.delete(sessionId);
                setMessageDeliveryRevision((revision) => revision + 1);
              }, 5_000);
              deliveryRetryTimersRef.current.set(sessionId, timer);
            }
            if (complete || afterCount !== beforeCount)
              setMessageDeliveryRevision((revision) => revision + 1);
          }
        })()
          .catch(() => undefined)
          .finally(() => deliveryPageReadsRef.current.delete(sessionId));
      }
    }
  }, [backend, sessions, connection.state, messageDeliveryRevision]);

  useEffect(
    () => () => {
      for (const timer of deliveryRetryTimersRef.current.values())
        window.clearTimeout(timer);
      deliveryRetryTimersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const due = messageDeliveryTrackerRef.current!.nextDeadline();
    if (due === undefined) return;
    const timer = window.setTimeout(() => {
      messageDeliveryTrackerRef.current!.advance(Date.now());
      setMessageDeliveryRevision((revision) => revision + 1);
    }, Math.max(0, due - Date.now()));
    return () => window.clearTimeout(timer);
  }, [messageDeliveryRevision]);

  return {
    messageDeliveryTrackerRef,
    messageDeliveryRevision,
    setMessageDeliveryRevision,
  };
}
