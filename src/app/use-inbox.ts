import { useCallback, useEffect, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import { summarizeSessionAttention } from "../../shared/desktop-integration";
import type { CenterView } from "./shell-model";

export function useInbox(
  backend: AgentBackend,
  chatId: string | null,
  centerView: CenterView,
  selectedSession: AgentSession | null,
  sessions: AgentSession[],
  setNavOpen: Dispatch<SetStateAction<boolean>>,
  setCenterView: Dispatch<SetStateAction<CenterView>>,
) {
  useEffect(() => {
    if (!chatId) return;
    void backend.markSessionRead(chatId);
  }, [backend, chatId]);
  // A turn that finishes while its session is on screen sets `unread` without
  // changing the selection, which left it in the inbox. Only a window the user can
  // see counts, so work that finishes behind another app still waits for them.
  const selectedUnread = selectedSession?.unread === true;
  const conversationShown = centerView === "conversation";
  useEffect(() => {
    if (!chatId || !conversationShown || !selectedUnread) return;
    const markIfSeen = (): void => {
      if (!document.hidden && document.hasFocus())
        void backend.markSessionRead(chatId).catch(() => undefined);
    };
    markIfSeen();
    window.addEventListener("focus", markIfSeen);
    document.addEventListener("visibilitychange", markIfSeen);
    return () => {
      window.removeEventListener("focus", markIfSeen);
      document.removeEventListener("visibilitychange", markIfSeen);
    };
  }, [backend, chatId, conversationShown, selectedUnread]);
  const toggleInbox = useCallback(() => {
    // On a phone the rail is a drawer over the content; the inbox is what the
    // user asked to see, so the drawer gets out of its way.
    setNavOpen(false);
    setCenterView((view) => (view === "inbox" ? "conversation" : "inbox"));
  }, [setCenterView, setNavOpen]);
  const inboxCount = useMemo(() => {
    const attention = summarizeSessionAttention(sessions);
    return attention.needsInput + attention.unreadCompleted;
  }, [sessions]);

  return { toggleInbox, inboxCount };
}
