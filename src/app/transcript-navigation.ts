import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  TranscriptPage,
  TranscriptPageRequest,
} from "../../shared/agent-contract";
import type { TranscriptItem } from "../backend/types";
import type { AgentBackend } from "../backend/agent-backend";
import { t } from "../i18n";
import { humanErrorMessage } from "./format";
import { EMPTY_TRANSCRIPT_PAGE_STATE } from "./shell-model";
import type {
  SessionTranscriptPageState,
  TranscriptPageMergeMode,
  TranscriptPageScope,
} from "./shell-model";

export interface TranscriptNavigationContext {
  backend: AgentBackend;
  selectedIdRef: MutableRefObject<string | null>;
  transcriptsRef: MutableRefObject<Record<string, TranscriptItem[]>>;
  transcriptPageStatesRef: MutableRefObject<Record<string, SessionTranscriptPageState>>;
  revealRequestGenerationRef: MutableRefObject<number>;
  setRevealTarget: Dispatch<SetStateAction<{ sessionId: string; itemId: string } | null>>;
  setSentRequestToken: Dispatch<SetStateAction<number>>;
  setAppError: (message: string) => void;
  updateTranscriptPageState: (
    sessionId: string,
    update: (current: SessionTranscriptPageState) => SessionTranscriptPageState,
  ) => void;
  readTranscriptPage: (
    sessionId: string,
    request: TranscriptPageRequest | undefined,
    mode: TranscriptPageMergeMode,
    scope: TranscriptPageScope,
  ) => Promise<TranscriptPage | undefined>;
}

export function createTranscriptNavigation(context: TranscriptNavigationContext) {
  const {
    backend,
    selectedIdRef,
    transcriptsRef,
    transcriptPageStatesRef,
    revealRequestGenerationRef,
    setRevealTarget,
    setSentRequestToken,
    setAppError,
    updateTranscriptPageState,
    readTranscriptPage,
  } = context;
  async function loadEarlierTranscript(): Promise<void> {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    const pageState = transcriptPageStatesRef.current[sessionId] ?? EMPTY_TRANSCRIPT_PAGE_STATE;
    const beforeId = pageState.firstId ?? transcriptsRef.current[sessionId]?.[0]?.id;
    if (!pageState.hasMoreBefore || !beforeId) return;
    updateTranscriptPageState(sessionId, (current) => ({
      ...current,
      loadingEarlier: true,
      earlierError: "",
    }));
    try {
      const page = await readTranscriptPage(
        sessionId,
        { beforeId },
        "prepend",
        pageState.scope,
      );
      if (!page)
        updateTranscriptPageState(sessionId, (current) => ({
          ...current,
          loadingEarlier: false,
        }));
    } catch (error) {
      updateTranscriptPageState(sessionId, (current) => ({
        ...current,
        loadingEarlier: false,
        earlierError: humanErrorMessage(error),
      }));
    }
  }
  async function returnTranscriptToLatest(): Promise<void> {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    const generation = ++revealRequestGenerationRef.current;
    setRevealTarget(null);
    updateTranscriptPageState(sessionId, (current) => ({
      ...current,
      loadingPage: true,
      pageError: "",
    }));
    try {
      const page = await readTranscriptPage(
        sessionId,
        undefined,
        "replace",
        { kind: "latest" },
      );
      if (
        page &&
        selectedIdRef.current === sessionId &&
        revealRequestGenerationRef.current === generation
      )
        setSentRequestToken((token) => token + 1);
    } catch (error) {
      if (revealRequestGenerationRef.current === generation)
        updateTranscriptPageState(sessionId, (current) => ({
          ...current,
          loadingPage: false,
          pageError: humanErrorMessage(error),
        }));
    }
  }
  function revealTranscriptItem(itemId: string): void {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    const generation = ++revealRequestGenerationRef.current;
    if (transcriptsRef.current[sessionId]?.some((item) => item.id === itemId)) {
      setRevealTarget({ sessionId, itemId });
      return;
    }
    void readTranscriptPage(
      sessionId,
      { aroundId: itemId },
      "replace",
      { kind: "around", id: itemId },
    ).then((page) => {
      if (
        !page ||
        selectedIdRef.current !== sessionId ||
        revealRequestGenerationRef.current !== generation
      )
        return;
      if (!page.items.some((item) => item.id === itemId)) {
        setAppError(t("요청 위치를 대화에서 찾지 못했습니다."));
        return;
      }
      setRevealTarget({ sessionId, itemId });
    }).catch((error) => {
      if (selectedIdRef.current === sessionId &&
          revealRequestGenerationRef.current === generation)
        setAppError(humanErrorMessage(error));
    });
  }
  async function retrySelectedTranscriptPage(): Promise<void> {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    updateTranscriptPageState(sessionId, (current) => ({
      ...current,
      loadingPage: true,
      pageError: "",
      scope: { kind: "latest" },
    }));
    try {
      await readTranscriptPage(sessionId, undefined, "replace", { kind: "latest" });
      void backend.refreshSessionContext?.(sessionId).catch(() => undefined);
    } catch (error) {
      updateTranscriptPageState(sessionId, (current) => ({
        ...current,
        loadingPage: false,
        pageError: humanErrorMessage(error),
      }));
    }
  }

  return {
    loadEarlierTranscript,
    returnTranscriptToLatest,
    revealTranscriptItem,
    retrySelectedTranscriptPage,
  };
}
