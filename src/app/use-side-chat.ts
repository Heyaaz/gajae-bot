import { useEffect, useMemo, useState } from "react";
import type { MutableRefObject } from "react";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentCommand, AgentSession } from "../backend/types";
import { useSideQuestions } from "./side-questions";

export function useSideChat(
  backend: AgentBackend,
  selectedCommands: readonly AgentCommand[],
  commandsPending: boolean,
  surfaceRef: MutableRefObject<"chat" | "terminal">,
  selectedSessionRef: MutableRefObject<AgentSession | null>,
) {
  const [sideOpen, setSideOpen] = useState(false);
  const askSideBackend = useMemo(
    () =>
      backend.askSideQuestion
        ? (sessionId: string, question: string) => backend.askSideQuestion!(sessionId, question)
        : undefined,
    [backend],
  );
  const { threads: sideThreads, askSide, retrySide, clearSide } = useSideQuestions(askSideBackend);

  // ⌘⇧B: the side chat panel.
  useEffect(() => {
    if (!askSideBackend) return;
    function onSideShortcut(event: globalThis.KeyboardEvent): void {
      if (
        !event.metaKey ||
        !event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.code !== "KeyB" ||
        surfaceRef.current === "terminal" ||
        !selectedSessionRef.current
      )
        return;
      event.preventDefault();
      setSideOpen((open) => !open);
    }
    window.addEventListener("keydown", onSideShortcut);
    return () => window.removeEventListener("keydown", onSideShortcut);
  }, [askSideBackend]);

  // GJC advertises `/btw` only when it has `btw.ask`. Until the list arrives the
  // question is tried and any refusal is shown in the panel.
  const sideUnsupported =
    askSideBackend !== undefined &&
    !commandsPending &&
    !selectedCommands.some((command) => command.name === "btw");
  const askSideFromComposer = askSideBackend
    ? (sessionId: string, question: string) => {
        setSideOpen(true);
        if (!sideUnsupported) askSide(sessionId, question);
      }
    : undefined;

  return {
    askSideBackend,
    sideOpen,
    setSideOpen,
    sideThreads,
    askSide,
    retrySide,
    clearSide,
    sideUnsupported,
    askSideFromComposer,
  };
}
