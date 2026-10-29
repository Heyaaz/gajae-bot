import { Check, GitCompare, MessageSquare, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffSnapshot } from "../../shared/agent-contract";
import type { ParallelDesktopBridge } from "../../shared/parallel-ipc";
import {
  attemptSessionId,
  type ParallelAttempt,
  type ParallelGroup,
} from "../../shared/parallel-run";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import { t, useLanguage } from "../i18n";
import {
  humanErrorMessage,
  parallelStateLabel,
  sessionTitleText,
  statusLabel,
} from "./format";
import { DiffPanel } from "./inspector";

export interface ParallelViewProps {
  group: ParallelGroup;
  sessions: readonly AgentSession[];
  backend: AgentBackend;
  bridge: ParallelDesktopBridge;
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
  onSubmitReview?: (sessionId: string, text: string) => void;
}

interface DiffState {
  diff: DiffSnapshot | null;
  loading: boolean;
}

/** A cancelled native confirmation is the user's answer, not a failure to report. */
function cancelled(error: unknown): boolean {
  return /Operation cancelled/u.test(
    error instanceof Error ? error.message : String(error),
  );
}

function attemptStatus(attempt: ParallelAttempt, session?: AgentSession): string {
  switch (attempt.state.kind) {
    case "creating":
      return t("만드는 중");
    case "removed":
      return t("정리됨");
    case "failed":
      return t`실패: ${attempt.state.reason}`;
    case "started":
      return session ? statusLabel(session.status, session.phase) : t("세션 없음");
  }
}

/** The preset the runtime reports, stripped of the catalog prefix GJC may add. */
function runtimePreset(session?: AgentSession): string | undefined {
  return session?.model?.replace(/^gajae-code\//u, "");
}

export function ParallelView({
  group,
  sessions,
  backend,
  bridge,
  onOpenSession,
  onClose,
  onError,
  onSubmitReview,
}: ParallelViewProps) {
  useLanguage();
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const [closedDiffs, setClosedDiffs] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const live = group.attempts.flatMap((attempt) => {
    const sessionId = attempt.state.kind === "removed" ? undefined : attemptSessionId(attempt);
    return sessionId ? [sessionId] : [];
  });
  // A diff is read again whenever an attempt's state changes: a run that just
  // finished is exactly when its changes are worth looking at.
  const diffKey = live
    .map((sessionId) => `${sessionId}:${sessionsById.get(sessionId)?.status ?? ""}`)
    .join("|");
  const requests = useRef(new Map<string, number>());

  const loadDiff = useCallback((sessionId: string): void => {
    const request = (requests.current.get(sessionId) ?? 0) + 1;
    requests.current.set(sessionId, request);
    setDiffs((current) => ({
      ...current,
      [sessionId]: { diff: current[sessionId]?.diff ?? null, loading: true },
    }));
    void backend.getDiff(sessionId).then(
      (diff) => {
        if (requests.current.get(sessionId) === request)
          setDiffs((current) => ({ ...current, [sessionId]: { diff, loading: false } }));
      },
      (error: unknown) => {
        if (requests.current.get(sessionId) !== request) return;
        setDiffs((current) => ({
          ...current,
          [sessionId]: {
            diff: {
              sessionId,
              workspace: "",
              files: [],
              refreshedAt: "",
              error: humanErrorMessage(error),
            },
            loading: false,
          },
        }));
      },
    );
  }, [backend]);

  useEffect(() => {
    if (!diffKey) return;
    queueMicrotask(() => {
      for (const entry of diffKey.split("|"))
        loadDiff(entry.slice(0, entry.lastIndexOf(":")));
    });
  }, [diffKey, loadDiff]);

  useEffect(() => {
    function closeWithEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as { tagName?: unknown } | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      event.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [onClose]);

  async function act(work: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      if (!cancelled(error)) onError(humanErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const adoptedId = group.state.kind === "adopted" ? group.state.attemptId : undefined;
  const removedAny = group.attempts.some((attempt) => attempt.state.kind === "removed");
  const canAdopt =
    group.state.kind === "running" ||
    group.state.kind === "comparing" ||
    (group.state.kind === "adopted" && !removedAny);
  const leftovers = group.attempts.some(
    (attempt) => attempt.id !== adoptedId && attempt.state.kind !== "removed",
  );
  const decided = group.state.kind === "adopted" || group.state.kind === "discarded";

  return (
    <main
      className="parallel-view"
      aria-label={t("병렬 실행 비교")}
      style={{ ["--parallel-attempts" as string]: group.attempts.length }}
    >
      <header className="parallel-view__header">
        <GitCompare size={16} aria-hidden="true" />
        <strong>{sessionTitleText(group.title)}</strong>
        <small data-state={group.state.kind}>{parallelStateLabel(group.state)}</small>
        <span className="parallel-view__actions">
          {(group.state.kind === "running" || group.state.kind === "comparing") && (
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await bridge.discard(group.id);
                  await bridge.cleanup(group.id);
                })
              }
            >
              {t("모두 버리기")}
            </button>
          )}
          {decided && leftovers && (
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => void act(() => bridge.cleanup(group.id))}
            >
              {adoptedId ? t("나머지 정리") : t("시도 정리")}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            title={t("대화로 돌아가기")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </span>
      </header>
      <details className="parallel-view__prompt">
        <summary>{t("보낸 요청")}</summary>
        <pre>{group.prompt}</pre>
      </details>
      <div className="parallel-view__attempts">
        {group.attempts.map((attempt) => {
          const sessionId = attemptSessionId(attempt);
          const session = sessionId ? sessionsById.get(sessionId) : undefined;
          const diffState = sessionId ? diffs[sessionId] : undefined;
          const ranOn = runtimePreset(session);
          const showDiff =
            session && attempt.state.kind !== "removed" && !closedDiffs.has(attempt.id);
          return (
            <section
              key={attempt.id}
              className="parallel-attempt"
              data-attempt={attempt.id}
              data-state={attempt.state.kind}
              aria-label={t`시도 #${attempt.id}`}
            >
              <header className="parallel-attempt__header">
                <span className="parallel-attempt__title">
                  <strong>#{attempt.id}</strong>
                  <span>{attempt.preset}</span>
                  {adoptedId === attempt.id && (
                    <em className="parallel-attempt__adopted">
                      <Check size={11} aria-hidden="true" /> {t("채택함")}
                    </em>
                  )}
                </span>
                <span className="parallel-attempt__status">
                  {attemptStatus(attempt, session)}
                </span>
                <code className="parallel-attempt__branch">{attempt.branch}</code>
                <span className="parallel-attempt__facts">
                  {ranOn && ranOn !== attempt.preset ? (
                    <span className="parallel-attempt__warning">
                      {t`실행 모델 ${ranOn} · 요청과 다름`}
                    </span>
                  ) : ranOn ? (
                    <span>{t`실행 모델 ${ranOn}`}</span>
                  ) : null}
                  {diffState?.diff && !diffState.diff.error && (
                    <span className="parallel-attempt__files">
                      {t`변경 파일 ${diffState.diff.files.length}개`}
                    </span>
                  )}
                  {session?.usagePercent !== undefined && (
                    <span>{t`컨텍스트 ${session.usagePercent.toFixed(1)}%`}</span>
                  )}
                </span>
                <span className="parallel-attempt__buttons">
                  {session && attempt.state.kind !== "removed" && (
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => onOpenSession(session.id)}
                    >
                      <MessageSquare size={12} aria-hidden="true" /> {t("대화 열기")}
                    </button>
                  )}
                  {session && closedDiffs.has(attempt.id) && attempt.state.kind !== "removed" && (
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() =>
                        setClosedDiffs((current) => {
                          const next = new Set(current);
                          next.delete(attempt.id);
                          return next;
                        })
                      }
                    >
                      {t("diff 보기")}
                    </button>
                  )}
                  {canAdopt && sessionId && adoptedId !== attempt.id && (
                    <button
                      type="button"
                      className="button-primary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await bridge.adopt(group.id, attempt.id);
                          await bridge.cleanup(group.id);
                        })
                      }
                    >
                      {t("이 시도 채택")}
                    </button>
                  )}
                </span>
              </header>
              {showDiff && (
                <DiffPanel
                  session={session}
                  backend={backend}
                  diff={diffState?.diff ?? null}
                  loading={diffState?.loading ?? true}
                  onRefresh={() => loadDiff(session.id)}
                  onClose={() =>
                    setClosedDiffs((current) => new Set(current).add(attempt.id))
                  }
                  onSubmitReview={onSubmitReview}
                />
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
