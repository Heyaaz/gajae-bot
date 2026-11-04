import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { MessageDelivery } from "../../shared/agent-contract";
import type { AgentBackend } from "../backend/agent-backend";
import type {
  AgentCommand,
  AgentSession,
  BackendConnection,
  MessageInput,
  TranscriptItem,
} from "../backend/types";
import { deliveryEchoMatches, isTrackableMessageInput } from "../message-delivery";
import type { MessageDeliveryTracker } from "../message-delivery";
import { t } from "../i18n";
import { cacheTranscript, lastUserRequestContent, mergeTranscriptItem } from "../transcript-utils";
import { BUNDLED_GJC_COMMANDS, humanErrorMessage } from "./format";
import { deliverySessionState, isNotExecutedDelivery, lastDurableUserRequest } from "./shell-model";
import type { ShellSendMessage, ShellSendOptions } from "./shell-model";
import type { useTranscriptStore } from "./use-transcript-store";

type TranscriptStore = ReturnType<typeof useTranscriptStore>;

export interface SendMessageContext {
  backend: AgentBackend;
  sessionsRef: MutableRefObject<AgentSession[]>;
  connectionRef: MutableRefObject<BackendConnection>;
  commands: Record<string, AgentCommand[]>;
  pendingSessions: MutableRefObject<Map<string, Promise<AgentSession>>>;
  selectedIdRef: MutableRefObject<string | null>;
  revealRequestGenerationRef: MutableRefObject<number>;
  messageDeliveryTrackerRef: MutableRefObject<MessageDeliveryTracker | null>;
  sendMessageRef: MutableRefObject<ShellSendMessage | null>;
  resolveSessionId: (sessionId: string) => Promise<string>;
  setRevealTarget: (target: null) => void;
  setSentRequestToken: Dispatch<SetStateAction<number>>;
  setMessageDeliveryRevision: Dispatch<SetStateAction<number>>;
  setTranscripts: TranscriptStore["setTranscripts"];
  setAppError: (message: string) => void;
  transcriptsRef: TranscriptStore["transcriptsRef"];
  transcriptPageStatesRef: TranscriptStore["transcriptPageStatesRef"];
  requestSummariesRef: TranscriptStore["requestSummariesRef"];
  pendingTranscriptScopesRef: TranscriptStore["pendingTranscriptScopesRef"];
  transcriptPageGenerationsRef: TranscriptStore["transcriptPageGenerationsRef"];
  transcriptPageInFlightRef: TranscriptStore["transcriptPageInFlightRef"];
  transcriptItemVersionsRef: TranscriptStore["transcriptItemVersionsRef"];
  updateTranscriptPageState: TranscriptStore["updateTranscriptPageState"];
  readTranscriptPage: TranscriptStore["readTranscriptPage"];
}

export function useSendMessage(context: SendMessageContext) {
  const {
    backend,
    sessionsRef,
    connectionRef,
    commands,
    pendingSessions,
    selectedIdRef,
    revealRequestGenerationRef,
    messageDeliveryTrackerRef,
    sendMessageRef,
    resolveSessionId,
    setRevealTarget,
    setSentRequestToken,
    setMessageDeliveryRevision,
    setTranscripts,
    setAppError,
    transcriptsRef,
    transcriptPageStatesRef,
    requestSummariesRef,
    pendingTranscriptScopesRef,
    transcriptPageGenerationsRef,
    transcriptPageInFlightRef,
    transcriptItemVersionsRef,
    updateTranscriptPageState,
    readTranscriptPage,
  } = context;
  async function sendMessage(
    sessionId: string,
    input: MessageInput,
    options: ShellSendOptions = {},
  ): Promise<MessageDelivery> {
    const resolvedSessionId = await resolveSessionId(sessionId);
    const tracker = messageDeliveryTrackerRef.current!;
    const session =
      sessionsRef.current.find((candidate) => candidate.id === resolvedSessionId) ??
      (await pendingSessions.current.get(sessionId));
    let baseline =
      transcriptsRef.current[resolvedSessionId] ??
      transcriptsRef.current[sessionId];
    let baselineKnown = baseline !== undefined;
    const pageState = transcriptPageStatesRef.current[resolvedSessionId];
    const isSelectedSend =
      options.quiet !== true && selectedIdRef.current === resolvedSessionId;
    if (isSelectedSend) {
      revealRequestGenerationRef.current += 1;
      setRevealTarget(null);
      if (pendingTranscriptScopesRef.current.get(resolvedSessionId)?.kind === "around") {
        transcriptPageGenerationsRef.current.set(resolvedSessionId,
          (transcriptPageGenerationsRef.current.get(resolvedSessionId) ?? 0) + 1);
        pendingTranscriptScopesRef.current.delete(resolvedSessionId);
        transcriptPageInFlightRef.current.delete(resolvedSessionId);
        updateTranscriptPageState(resolvedSessionId, (current) => ({
          ...current, loadingPage: false, pageError: "", loadingEarlier: false,
        }));
      }
    }
    const mustInstallLatest =
      isSelectedSend &&
      (pageState?.scope.kind === "around" || pageState?.hasMoreAfter === true);
    const needsLatestBaseline =
      !baselineKnown ||
      pageState?.scope.kind === "around" ||
      pageState?.hasMoreAfter === true;
    if (needsLatestBaseline) {
      try {
        if (isSelectedSend)
          updateTranscriptPageState(resolvedSessionId, (current) => ({
            ...current,
            loadingPage: true,
            pageError: "",
          }));
        const latest = isSelectedSend
          ? await readTranscriptPage(
              resolvedSessionId,
              undefined,
              "replace",
              { kind: "latest" },
            )
          : await backend.getTranscriptPage(resolvedSessionId);
        if (!latest) throw new Error(t("최신 대화를 불러오지 못했습니다."));
        baseline = latest.items;
        const lastDurableRequest = lastDurableUserRequest(latest.items);
        const latestIndexedRequest = latest.requests.at(-1);
        baselineKnown = lastDurableRequest
          ? latestIndexedRequest?.id === lastDurableRequest.id
          : latest.requests.length === 0 && !latest.hasMoreBefore;
      } catch (error) {
        if (isSelectedSend)
          updateTranscriptPageState(resolvedSessionId, (current) => ({
            ...current,
            loadingPage: false,
            pageError: humanErrorMessage(error),
          }));
        if (mustInstallLatest) {
          if (options.retryId) {
            const retryGeneration = tracker.submissionGeneration(options.retryId);
            if (retryGeneration !== undefined) {
              tracker.rejectSubmission(
                options.retryId,
                Date.now(),
                retryGeneration,
                true,
              );
              setMessageDeliveryRevision((revision) => revision + 1);
            }
          }
          throw error;
        }
        baseline = baseline ?? [];
        baselineKnown = false;
      }
    } else if (baseline) {
      const durable = lastDurableUserRequest(baseline);
      const summaries = requestSummariesRef.current[resolvedSessionId] ?? [];
      baselineKnown = durable
        ? summaries.length === 0 || summaries.at(-1)?.id === durable.id
        : summaries.length === 0 && !pageState?.hasMoreBefore;
    }
    const now = Date.now();
    const sessionState = deliverySessionState(
      session,
      connectionRef.current.state,
    );
    let deliveryAttemptId = options.retryId;
    if (options.retryId) {
      tracker.submitRetry(
        options.retryId,
        resolvedSessionId,
        baseline ?? [],
        now,
        sessionState,
        baselineKnown,
      );
    } else if (
      isTrackableMessageInput(
        input,
        [...BUNDLED_GJC_COMMANDS, ...(commands[resolvedSessionId] ?? [])],
      )
    ) {
      deliveryAttemptId = tracker.submit(
        resolvedSessionId,
        input,
        baseline ?? [],
        now,
        sessionState,
        baselineKnown,
      );
    }
    const generation = deliveryAttemptId
      ? tracker.submissionGeneration(deliveryAttemptId)
      : undefined;
    setMessageDeliveryRevision((revision) => revision + 1);
    let rendererEchoId: string | undefined;
    const text = input.text.trim();
    const prompt = text.replace(/^\/(?:steer|queue)(?:\s+|$)/u, "").trim();
    if (prompt && (!text.startsWith("/") || /^\/(?:steer|queue)(?:\s+|$)/u.test(text))) {
      const echo: TranscriptItem = {
        id: `local-prompt-renderer-${crypto.randomUUID()}`,
        sessionId: resolvedSessionId, kind: "message", role: "user", content: prompt,
        // Same clock format as the controller's rows, so the label does not
        // change (오후 01:22 -> 13:22) when the confirmed row replaces this one.
        createdAt: new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()),
        streaming: false,
        ...(input.images.length ? { images: input.images } : {}),
      };
      rendererEchoId = echo.id;
      setTranscripts((current) => {
        const next = cacheTranscript(current, resolvedSessionId,
          mergeTranscriptItem(current[resolvedSessionId] ?? [], echo),
        );
        transcriptsRef.current = next;
        return next;
      });
    }
    // Answering the reader is part of sending: the transcript takes the view to the
    // newest content, so the request they just made and the reply to it appear where
    // they are looking instead of below a scroll position they had left behind.
    if (
      options.quiet !== true &&
      selectedIdRef.current === resolvedSessionId
    ) {
      setSentRequestToken((token) => token + 1);
    }
    try {
      const result = await backend.sendMessage(resolvedSessionId, input);
      if (deliveryAttemptId && generation !== undefined) {
        if (isNotExecutedDelivery(result))
          tracker.markNotExecuted(
            deliveryAttemptId,
            result.detail,
            generation,
            Date.now(),
          );
        else if (options.retryId)
          tracker.finishRetry(deliveryAttemptId, Date.now(), generation);
        else tracker.acceptSubmission(deliveryAttemptId, Date.now(), generation);
        setMessageDeliveryRevision((revision) => revision + 1);
      }
      return result;
    } catch (error) {
      if (rendererEchoId) {
        const echoId = rendererEchoId;
        setTranscripts((current) => {
          const items = current[resolvedSessionId];
          if (!items?.some((item) => item.id === echoId)) return current;
          return {
            ...current,
            [resolvedSessionId]: items.filter((item) => item.id !== echoId),
          };
        });
      }
      if (deliveryAttemptId && generation !== undefined) {
        tracker.rejectSubmission(
          deliveryAttemptId,
          Date.now(),
          generation,
          options.retryId !== undefined,
        );
        setMessageDeliveryRevision((revision) => revision + 1);
      }
      setAppError(humanErrorMessage(error));
      throw error;
    }
  }

  // A run-failure notice's 다시 시도 button: resends the session's own last request
  // rather than making the user retype it. Text only -- the transcript does not
  // keep the original attachments to resend alongside it.
  // The transcript changes on every streaming chunk. Reading it through a ref keeps
  // this callback — and the memoized row that receives it — the same across those
  // chunks. The text is read when the button is pressed, not when the row rendered.
  sendMessageRef.current = sendMessage;
  const retryMessageDelivery = useCallback((attemptId: string): void => {
    const pending = messageDeliveryTrackerRef.current!.beginRetry(attemptId);
    if (!pending) return;
    // A failed request leaves its optimistic echo behind while the failure row
    // replaces it. Remove every matching echo before the retry adds a fresh one;
    // otherwise the old echo resurfaces once the tracker confirms the retry.
    setTranscripts((current) => {
      const items = current[pending.sessionId];
      if (!items) return current;
      const removedIds = new Set(
        items
          .filter((item) => deliveryEchoMatches(pending.input, item))
          .map((item) => item.id),
      );
      if (removedIds.size === 0) return current;
      // The page read inside sendMessage preserves rows that arrived after its
      // read version. A removed echo is not new content; clear its version so
      // that preservation cannot resurrect it next to the durable row.
      const versions = transcriptItemVersionsRef.current.get(pending.sessionId);
      for (const id of removedIds) versions?.delete(id);
      const remaining = items.filter((item) => !removedIds.has(item.id));
      // Do not use cacheTranscript here: it deliberately preserves optimistic
      // echoes that the incoming list does not confirm, which would put the
      // failed request's echo straight back.
      const next = { ...current, [pending.sessionId]: remaining };
      transcriptsRef.current = next;
      return next;
    });
    setMessageDeliveryRevision((revision) => revision + 1);
    void sendMessageRef.current!(pending.sessionId, pending.input, {
      retryId: attemptId,
    }).catch(() => undefined);
  }, []);
  const retryLastRequest = useCallback((sessionId: string): void => {
    const text = lastUserRequestContent(transcriptsRef.current[sessionId] ?? []);
    if (!text) return;
    void sendMessageRef.current!(sessionId, { text, images: [], files: [] });
  }, []);

  return { sendMessage, retryMessageDelivery, retryLastRequest };
}
