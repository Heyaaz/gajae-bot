import { useEffect, useRef, useState } from "react";
import type {
  TranscriptPage,
  TranscriptPageRequest,
  TranscriptRequestSummary,
} from "../../shared/agent-contract";
import type { TranscriptItem } from "../backend/types";
import type { AgentBackend } from "../backend/agent-backend";
import { cacheTranscript, mergeTranscriptItem } from "../transcript-utils";
import {
  mergeRequestSummaries,
  mergeTranscriptPage,
  mergeTranscriptPatch,
  mergeTranscriptTail,
  refreshTranscriptWindow,
} from "../transcript-pages";
import { humanErrorMessage } from "./format";
import {
  EMPTY_TRANSCRIPT_PAGE_STATE,
  reconcilePageRequestIndex,
} from "./shell-model";
import type {
  SessionTranscriptPageState,
  TranscriptPageMergeMode,
  TranscriptPageScope,
} from "./shell-model";

export function useTranscriptStore(backend: AgentBackend) {
  const [transcripts, setTranscripts] = useState<
    Record<string, TranscriptItem[]>
  >({});
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;
  const [transcriptPageStates, setTranscriptPageStates] = useState<
    Record<string, SessionTranscriptPageState>
  >({});
  const transcriptPageStatesRef = useRef(transcriptPageStates);
  transcriptPageStatesRef.current = transcriptPageStates;
  const [requestSummariesBySession, setRequestSummariesBySession] = useState<
    Record<string, TranscriptRequestSummary[]>
  >({});
  const requestSummariesRef = useRef(requestSummariesBySession);
  requestSummariesRef.current = requestSummariesBySession;

  const transcriptPageGenerationsRef = useRef(new Map<string, number>());
  const initialPageReadsRef = useRef(new Map<string, Promise<TranscriptPage | undefined>>());
  const transcriptPageInFlightRef = useRef(new Set<string>());
  const transcriptEventVersionsRef = useRef(new Map<string, number>());
  /** Last revision applied by the 5s safety net, per session. */
  const transcriptRevisionsRef = useRef(new Map<string, string>());
  const transcriptItemVersionsRef = useRef(new Map<string, Map<string, number>>());
  const transcriptRequestEventVersionsRef = useRef(new Map<string, Map<string, number>>());
  const pendingTranscriptScopesRef = useRef(new Map<string, TranscriptPageScope>());

  useEffect(() => {
    const cachedIds = new Set(Object.keys(transcripts));
    const prune = <T,>(source: Record<string, T>): Record<string, T> =>
      Object.fromEntries(
        Object.entries(source).filter(([sessionId]) => cachedIds.has(sessionId)),
      );
    const pages = prune(transcriptPageStatesRef.current);
    if (Object.keys(pages).length !== Object.keys(transcriptPageStatesRef.current).length) {
      transcriptPageStatesRef.current = pages;
      setTranscriptPageStates(pages);
    }
    const summaries = prune(requestSummariesRef.current);
    if (Object.keys(summaries).length !== Object.keys(requestSummariesRef.current).length) {
      requestSummariesRef.current = summaries;
      setRequestSummariesBySession(summaries);
    }
  }, [transcripts]);

  function updateTranscriptPageState(
    sessionId: string,
    update: (current: SessionTranscriptPageState) => SessionTranscriptPageState,
  ): void {
    const current = transcriptPageStatesRef.current;
    const next = {
      ...current,
      [sessionId]: update(
        current[sessionId] ?? EMPTY_TRANSCRIPT_PAGE_STATE,
      ),
    };
    transcriptPageStatesRef.current = next;
    setTranscriptPageStates(next);
  }

  function noteTranscriptEvent(sessionId: string, itemIds: string[] = []): void {
    const version = (transcriptEventVersionsRef.current.get(sessionId) ?? 0) + 1;
    transcriptEventVersionsRef.current.set(sessionId, version);
    if (itemIds.length === 0) return;
    let itemVersions = transcriptItemVersionsRef.current.get(sessionId);
    if (!itemVersions) {
      itemVersions = new Map();
      transcriptItemVersionsRef.current.set(sessionId, itemVersions);
    }
    for (const id of itemIds) itemVersions.set(id, version);
    let requestVersions = transcriptRequestEventVersionsRef.current.get(sessionId);
    if (!requestVersions) {
      requestVersions = new Map();
      transcriptRequestEventVersionsRef.current.set(sessionId, requestVersions);
    }
    for (const id of itemIds) requestVersions.set(id, version);
  }

  function tracksTranscriptSession(sessionId: string): boolean {
    return Boolean(transcriptsRef.current[sessionId]) ||
      transcriptPageInFlightRef.current.has(sessionId);
  }

  function updateRequestSummaries(
    sessionId: string,
    items: readonly TranscriptItem[],
  ): void {
    const current = requestSummariesRef.current;
    const next = {
      ...current,
      [sessionId]: mergeRequestSummaries(current[sessionId] ?? [], items),
    };
    requestSummariesRef.current = next;
    setRequestSummariesBySession(next);
  }

  function mergePageRequestSummaries(
    sessionId: string,
    requests: TranscriptRequestSummary[],
    readVersion: number,
  ): void {
    const current = requestSummariesRef.current;
    const next = {
      ...current,
      [sessionId]: reconcilePageRequestIndex(
        current[sessionId] ?? [],
        requests,
        transcriptRequestEventVersionsRef.current.get(sessionId),
        readVersion,
      ),
    };
    requestSummariesRef.current = next;
    setRequestSummariesBySession(next);
  }

  async function readTranscriptPage(
    sessionId: string,
    request: TranscriptPageRequest | undefined,
    mode: TranscriptPageMergeMode,
    scope: TranscriptPageScope,
  ): Promise<TranscriptPage | undefined> {
    const generation = (transcriptPageGenerationsRef.current.get(sessionId) ?? 0) + 1;
    transcriptPageGenerationsRef.current.set(sessionId, generation);
    const protectsHistoricalView =
      scope.kind === "around" && mode !== "prepend";
    if (protectsHistoricalView)
      pendingTranscriptScopesRef.current.set(sessionId, scope);
    transcriptPageInFlightRef.current.add(sessionId);
    const readVersion = transcriptEventVersionsRef.current.get(sessionId) ?? 0;
    let page: TranscriptPage;
    try {
      page = mode === "around"
        ? await refreshTranscriptWindow(
            transcriptsRef.current[sessionId] ?? [],
            (pageRequest) => backend.getTranscriptPage(sessionId, pageRequest),
          )
        : await backend.getTranscriptPage(sessionId, request);
    } catch (error) {
      if (transcriptPageGenerationsRef.current.get(sessionId) === generation) {
        transcriptPageInFlightRef.current.delete(sessionId);
        pendingTranscriptScopesRef.current.delete(sessionId);
        if (mode === "around")
          updateTranscriptPageState(sessionId, (current) => ({
            ...current,
            loadingPage: false,
            pageError: humanErrorMessage(error),
          }));
      }
      throw error;
    }
    if (transcriptPageGenerationsRef.current.get(sessionId) !== generation)
      return undefined;

    setTranscripts((current) => {
      if (transcriptPageGenerationsRef.current.get(sessionId) !== generation)
        return current;
      const currentItems = current[sessionId] ?? [];
      const currentById = new Map(currentItems.map((item) => [item.id, item]));
      const itemVersions = transcriptItemVersionsRef.current.get(sessionId);
      const freshPage: TranscriptPage = {
        ...page,
        items: page.items.map((item) =>
          (itemVersions?.get(item.id) ?? 0) > readVersion
            ? currentById.get(item.id) ?? item
            : item,
        ),
      };
      let items: TranscriptItem[];
      if (mode === "prepend") {
        items = mergeTranscriptPage(currentItems, freshPage, "prepend");
      } else if (mode === "tail") {
        items = mergeTranscriptTail(currentItems, freshPage.items);
      } else if (mode === "around") {
        items = mergeTranscriptPage(currentItems, freshPage, "replace");
      } else {
        items = mergeTranscriptPage(currentItems, freshPage, "replace");
      }
      if (
        scope.kind === "latest" &&
        mode !== "prepend" &&
        mode !== "around"
      ) {
        const installedIds = new Set(items.map((item) => item.id));
        const arrivedDuringRead = currentItems.filter(
          (item) =>
            !installedIds.has(item.id) &&
            (itemVersions?.get(item.id) ?? 0) > readVersion,
        );
        if (arrivedDuringRead.length > 0) items = [...items, ...arrivedDuringRead];
      }
      const next = cacheTranscript(current, sessionId, items);
      transcriptsRef.current = next;
      return next;
    });
    if (transcriptPageGenerationsRef.current.get(sessionId) !== generation)
      return undefined;

    const previous = transcriptPageStatesRef.current[sessionId] ?? EMPTY_TRANSCRIPT_PAGE_STATE;
    const pageState: SessionTranscriptPageState = {
      ...previous,
      scope,
      loadingPage: false,
      pageError: "",
      loadingEarlier: false,
      earlierError: "",
    };
    if (mode === "prepend") {
      pageState.hasMoreBefore = page.hasMoreBefore;
      pageState.hasMoreAfter = previous.hasMoreAfter;
      pageState.firstId = page.firstId ?? previous.firstId;
      pageState.lastId = previous.lastId ?? page.lastId;
    } else if (mode === "tail") {
      pageState.hasMoreBefore = previous.hasMoreBefore || page.hasMoreBefore;
      pageState.hasMoreAfter = page.hasMoreAfter;
      pageState.firstId = previous.firstId ?? page.firstId;
      pageState.lastId = page.lastId ?? previous.lastId;
    } else if (mode === "around") {
      pageState.hasMoreBefore = page.hasMoreBefore;
      pageState.hasMoreAfter = page.hasMoreAfter;
      pageState.firstId = page.firstId;
      pageState.lastId = page.lastId;
    } else {
      pageState.hasMoreBefore = page.hasMoreBefore;
      pageState.hasMoreAfter = page.hasMoreAfter;
      pageState.firstId = page.firstId;
      pageState.lastId = page.lastId;
    }
    updateTranscriptPageState(sessionId, () => pageState);
    mergePageRequestSummaries(sessionId, page.requests, readVersion);
    transcriptPageInFlightRef.current.delete(sessionId);
    pendingTranscriptScopesRef.current.delete(sessionId);
    const finishedVersion = transcriptEventVersionsRef.current.get(sessionId) ?? 0;
    if (finishedVersion !== readVersion) {
      window.setTimeout(() => {
        if (
          transcriptEventVersionsRef.current.get(sessionId) === finishedVersion &&
          transcriptsRef.current[sessionId]
        )
          void refreshTranscriptPage(sessionId).catch(() => undefined);
      }, 200);
    }
    return page;
  }

  async function refreshTranscriptPage(sessionId: string): Promise<void> {
    if (!transcriptsRef.current[sessionId]) return;
    const pageState = transcriptPageStatesRef.current[sessionId];
    if (
      pageState?.scope.kind === "around" ||
      pageState?.hasMoreAfter
    ) {
      const anchorId = pageState?.scope.kind === "around"
        ? pageState.scope.id
        : pageState?.firstId ?? transcriptsRef.current[sessionId]?.[0]?.id;
      if (!anchorId) return;
      await readTranscriptPage(
        sessionId,
        { aroundId: anchorId },
        "around",
        { kind: "around", id: anchorId },
      );
      return;
    }
    // The latest view is a synchronization window: a revision stat can prove
    // that nothing changed, and a changed revision only needs the delta. The
    // bounded page remains the fallback when the backend cannot answer.
    if (backend.getTranscriptRevision && backend.getTranscriptChanges) {
      try {
        const revision = await backend.getTranscriptRevision(sessionId);
        if (revision !== undefined) {
          if (transcriptRevisionsRef.current.get(sessionId) === revision)
            return;
          const change = await backend.getTranscriptChanges(sessionId);
          if (!transcriptsRef.current[sessionId]) return;
          if (change.kind === "full" && change.items.length === 0) return;
          transcriptRevisionsRef.current.set(sessionId, revision);
          setTranscripts((current) => {
            const currentItems = current[sessionId];
            if (!currentItems) return current;
            const items = change.kind === "full"
              ? mergeTranscriptTail(currentItems, change.items)
              : mergeTranscriptPatch(currentItems, change.items);
            const next = cacheTranscript(current, sessionId, items);
            transcriptsRef.current = next;
            return next;
          });
          updateRequestSummaries(sessionId, change.items);
          return;
        }
      } catch {
        // Fall through to the bounded page read.
      }
    }
    await readTranscriptPage(sessionId, undefined, "tail", { kind: "latest" });
  }

  function mergeLiveTranscriptItems(
    sessionId: string,
    current: TranscriptItem[],
    incoming: readonly TranscriptItem[],
  ): TranscriptItem[] {
    const pageState = transcriptPageStatesRef.current[sessionId];
    const pendingScope = pendingTranscriptScopesRef.current.get(sessionId);
    const historical =
      pageState?.scope.kind === "around" ||
      pageState?.hasMoreAfter ||
      pendingScope?.kind === "around";
    let next = current;
    for (const item of incoming) {
      if (historical && !next.some((existing) => existing.id === item.id)) continue;
      next = mergeTranscriptItem(next, item);
    }
    return next;
  }

  return {
    transcripts,
    setTranscripts,
    transcriptsRef,
    transcriptPageStates,
    transcriptPageStatesRef,
    requestSummariesBySession,
    requestSummariesRef,
    initialPageReadsRef,
    transcriptPageGenerationsRef,
    transcriptPageInFlightRef,
    transcriptEventVersionsRef,
    transcriptRevisionsRef,
    transcriptItemVersionsRef,
    pendingTranscriptScopesRef,
    updateTranscriptPageState,
    noteTranscriptEvent,
    tracksTranscriptSession,
    updateRequestSummaries,
    readTranscriptPage,
    refreshTranscriptPage,
    mergeLiveTranscriptItems,
  };
}
