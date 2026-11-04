import { useCallback, useRef, useState } from "react";
import type { MessageInput } from "../backend/types";
import { t } from "../i18n";
import { humanErrorMessage } from "./format";

/** One `/btw` question in the side panel and what became of it. */
export type SideExchange =
  | { id: string; question: string; status: "pending"; askedAt: number }
  | { id: string; question: string; status: "answered"; answer: string }
  | { id: string; question: string; status: "failed"; error: string };

/** Earlier exchanges sent along with a follow-up, out of GJC's 16 KiB question limit. */
const CONTEXT_BUDGET_BYTES = 12 * 1024;

const encoder = new TextEncoder();

/** The question in a composer `/btw <question>` submission, when that is all it is. */
export function sideQuestionText(input: MessageInput): string | undefined {
  if (input.images.length > 0 || input.files.length > 0) return undefined;
  const match = /^\/btw(?:\s+([\s\S]*))?$/iu.exec(input.text.trim());
  const question = match?.[1]?.trim();
  return question || undefined;
}

/**
 * The text sent for a question. GJC keeps nothing between side questions, so a
 * follow-up carries the newest earlier answers that fit the budget.
 */
export function sideQuestionWithContext(
  history: readonly SideExchange[],
  question: string,
): string {
  const blocks: string[] = [];
  let used = encoder.encode(question).length;
  for (const exchange of [...history].reverse()) {
    if (exchange.status !== "answered") continue;
    const block = `Q: ${exchange.question}\nA: ${exchange.answer}`;
    const size = encoder.encode(block).length;
    if (used + size > CONTEXT_BUDGET_BYTES) break;
    blocks.unshift(block);
    used += size;
  }
  if (blocks.length === 0) return question;
  return [
    "Earlier questions and answers in this side chat:",
    ...blocks,
    `Follow-up question: ${question}`,
  ].join("\n\n");
}

/**
 * Side-panel exchanges, per session, for as long as the window is open. GJC
 * answers one side question at a time, so a session with one still pending
 * refuses the next here instead of reaching GJC's `busy`.
 */
export function useSideQuestions(
  ask: ((sessionId: string, question: string) => Promise<string>) | undefined,
) {
  const [threads, setThreads] = useState<Readonly<Record<string, readonly SideExchange[]>>>({});
  // The source of truth, written synchronously, so two questions asked in one tick
  // still see each other. `threads` follows it for rendering.
  const threadsRef = useRef(threads);

  const write = useCallback(
    (sessionId: string, change: (thread: readonly SideExchange[]) => readonly SideExchange[]) => {
      const current = threadsRef.current;
      threadsRef.current = { ...current, [sessionId]: change(current[sessionId] ?? []) };
      setThreads(threadsRef.current);
    },
    [],
  );
  const add = useCallback(
    (sessionId: string, exchange: SideExchange) => write(sessionId, (thread) => [...thread, exchange]),
    [write],
  );
  // An answer to an exchange cleared meanwhile has nowhere to go and is dropped.
  const settle = useCallback(
    (sessionId: string, exchange: SideExchange) =>
      write(sessionId, (thread) =>
        thread.map((entry) => (entry.id === exchange.id ? exchange : entry))),
    [write],
  );

  const askSide = useCallback(
    (sessionId: string, question: string) => {
      if (!ask) return;
      const id = crypto.randomUUID();
      const history = threadsRef.current[sessionId] ?? [];
      if (history.some((entry) => entry.status === "pending")) {
        add(sessionId, {
          id,
          question,
          status: "failed",
          error: t("앞선 질문의 답을 기다리는 중입니다. 답이 온 뒤에 다시 물어보세요."),
        });
        return;
      }
      add(sessionId, { id, question, status: "pending", askedAt: Date.now() });
      ask(sessionId, sideQuestionWithContext(history, question)).then(
        (answer) => settle(sessionId, { id, question, status: "answered", answer }),
        (error: unknown) =>
          settle(sessionId, { id, question, status: "failed", error: humanErrorMessage(error) }),
      );
    },
    [add, ask, settle],
  );

  /** Asks a failed question again in place of its failure. */
  const retrySide = useCallback(
    (sessionId: string, id: string) => {
      const failed = threadsRef.current[sessionId]?.find((entry) => entry.id === id);
      if (failed?.status !== "failed") return;
      write(sessionId, (thread) => thread.filter((entry) => entry.id !== id));
      askSide(sessionId, failed.question);
    },
    [askSide, write],
  );

  const clearSide = useCallback((sessionId: string) => {
    const { [sessionId]: _cleared, ...rest } = threadsRef.current;
    threadsRef.current = rest;
    setThreads(rest);
  }, []);

  return { threads, askSide, retrySide, clearSide };
}
