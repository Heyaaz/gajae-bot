import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AgentSession, BackendConnection, TranscriptItem } from "../backend/types";
import type { NewSessionPrefill } from "../../shared/settings-ipc";
import { escapeCancelsRun, invalidLinkMessage, isTextEntryTarget } from "./shell-model";
import type { CenterView } from "./shell-model";
import { parallelGroupIdOf } from "./sidebar-model";

export interface ShellShortcutsContext {
  surfaceRef: MutableRefObject<"chat" | "terminal">;
  selectedSessionRef: MutableRefObject<AgentSession | null>;
  sessionLinkRef: MutableRefObject<{ listed: boolean; waiting?: string }>;
  sessionsRef: MutableRefObject<AgentSession[]>;
  connection: BackendConnection;
  selectedSession: AgentSession | null;
  centerView: CenterView;
  searchOpen: boolean;
  newSessionRequest: { prefill?: NewSessionPrefill; serial: number } | null;
  resumeOpen: boolean;
  settingsOpen: boolean;
  findOpen: boolean;
  shortcutSessions: readonly AgentSession[];
  pendingApprovals: Extract<TranscriptItem, { kind: "tool" }>[];
  focusedApprovalId: string | undefined;
  createSession: (input: { title: string; workspace: string }) => void;
  cancelRun: (sessionId: string) => Promise<void>;
  openLinkedSession: (sessionId: string, known: readonly AgentSession[]) => void;
  openNewSessionDialog: (prefill?: NewSessionPrefill) => void;
  openParallelGroup: (groupId: string) => void;
  selectSession: (sessionId: string) => void;
  resolveToolCall: (toolId: string, optionId: string, comment?: string) => void;
  toggleInbox: () => void;
  setAppError: (message: string) => void;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setFindOpen: Dispatch<SetStateAction<boolean>>;
}

export function useShellShortcuts(context: ShellShortcutsContext): void {
  const {
    surfaceRef,
    selectedSessionRef,
    sessionLinkRef,
    sessionsRef,
    connection,
    selectedSession,
    centerView,
    searchOpen,
    newSessionRequest,
    resumeOpen,
    settingsOpen,
    findOpen,
    shortcutSessions,
    pendingApprovals,
    focusedApprovalId,
    createSession,
    cancelRun,
    openLinkedSession,
    openNewSessionDialog,
    openParallelGroup,
    selectSession,
    resolveToolCall,
    toggleInbox,
    setAppError,
    setSearchOpen,
    setFindOpen,
  } = context;
  // Dismissible surfaces own Escape while they are up: the key's job there is to
  // close the surface, and cancelling a run behind the dialog the user is reading is
  // never what they asked for. The dialogs only bind Escape on their own fields, so
  // with focus anywhere else in the dialog the key used to reach the abort shortcut.
  // The inbox covers the conversation, so Escape there must close it instead of
  // cancelling a run the user cannot see.
  const dismissibleSurfaceOpen =
    centerView === "inbox" ||
    centerView === "parallel" ||
    searchOpen ||
    newSessionRequest !== null ||
    resumeOpen ||
    settingsOpen ||
    findOpen;

  useEffect(() => {
    const unsubscribe = window.agentControlDesktop?.onSessionShortcut(
      (shortcut) => {
        if (shortcut.type === "abort") {
          if (surfaceRef.current === "terminal") return;
          const session = selectedSessionRef.current;
          if (session) void cancelRun(session.id).catch(() => undefined);
          return;
        }
        if (shortcut.type === "new") {
          if (shortcut.prefill) {
            openNewSessionDialog(shortcut.prefill);
            return;
          }
          const workspace = selectedSession?.workspace || connection.workspace;
          if (workspace) createSession({ title: "새 Gajae 세션", workspace });
          else openNewSessionDialog();
          return;
        }
        if (shortcut.type === "open") {
          if (sessionLinkRef.current.listed)
            openLinkedSession(shortcut.sessionId, sessionsRef.current);
          else sessionLinkRef.current.waiting = shortcut.sessionId;
          return;
        }
        if (shortcut.type === "invalidLink") {
          setAppError(invalidLinkMessage(shortcut.reason));
          return;
        }
        const session = shortcutSessions[shortcut.index];
        if (!session) return;
        const groupId = parallelGroupIdOf(session.id);
        if (groupId) openParallelGroup(groupId);
        else selectSession(session.id);
      },
    );
    const unsubscribeAbort = window.agentControlDesktop?.onAbortRun(() => {
      if (surfaceRef.current === "terminal") return;
      const session = selectedSessionRef.current;
      if (session) void cancelRun(session.id).catch(() => undefined);
    });
    function abortWithEscape(event: globalThis.KeyboardEvent): void {
      if (surfaceRef.current === "terminal") return;
      if (
        !escapeCancelsRun({
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          defaultPrevented: event.defaultPrevented,
          textEntry: isTextEntryTarget(event.target),
          surfaceOpen: dismissibleSurfaceOpen,
        })
      )
        return;
      event.preventDefault();
      const session = selectedSessionRef.current;
      if (session) void cancelRun(session.id).catch(() => undefined);
    }
    // Bubble phase, not capture: a dialog field, the rename editor and the composer
    // are all nearer the key and each one decides for itself whether Escape means
    // "close me" or "stop the run".
    window.addEventListener("keydown", abortWithEscape);
    return () => {
      unsubscribe?.();
      unsubscribeAbort?.();
      window.removeEventListener("keydown", abortWithEscape);
    };
  }, [
    connection.workspace,
    createSession,
    dismissibleSurfaceOpen,
    openLinkedSession,
    openNewSessionDialog,
    openParallelGroup,
    selectSession,
    selectedSession?.workspace,
    shortcutSessions,
    cancelRun,
  ]);

  // ⌘↵/⌘⌫ approve or reject the currently focused pending approval. MetaKey-gated
  // so it never fights the composer's own Enter handling, and ignored while a
  // dismissible surface is open for the same reason abortWithEscape is.
  useEffect(() => {
    function onApprovalShortcut(event: globalThis.KeyboardEvent): void {
      if (surfaceRef.current === "terminal") return;
      if (!event.metaKey || dismissibleSurfaceOpen) return;
      if (event.key !== "Enter" && event.key !== "Backspace") return;
      const pending = pendingApprovals;
      if (pending.length === 0) return;
      const focused =
        pending.find((tool) => tool.id === focusedApprovalId) ?? pending[0]!;
      const option = focused.permissionOptions?.find((candidate) =>
        event.key === "Enter"
          ? candidate.kind.startsWith("allow")
          : candidate.kind.startsWith("reject"),
      );
      if (!option) return;
      event.preventDefault();
      resolveToolCall(focused.id, option.optionId);
    }
    window.addEventListener("keydown", onApprovalShortcut);
    return () => window.removeEventListener("keydown", onApprovalShortcut);
  }, [dismissibleSurfaceOpen, pendingApprovals, focusedApprovalId, resolveToolCall, surfaceRef]);

  // ⌘F: find within the open conversation. Distinct from ⌘K (sidebar's cross-session
  // global search, opened by focusing its own input) -- this one does not compete
  // with a browser/OS find because the window never ships its own, and it is
  // deliberately allowed through from inside a text field the same way a native
  // find shortcut is.
  useEffect(() => {
    function onFindShortcut(event: globalThis.KeyboardEvent): void {
      if (surfaceRef.current === "terminal") return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      if (!selectedSessionRef.current) return;
      event.preventDefault();
      setFindOpen(true);
    }
    window.addEventListener("keydown", onFindShortcut);
    return () => window.removeEventListener("keydown", onFindShortcut);
  }, [selectedSessionRef, setFindOpen, surfaceRef]);

  useEffect(() => {
    function openGlobalSearch(event: globalThis.KeyboardEvent): void {
      if (
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        surfaceRef.current === "terminal" ||
        event.key.toLowerCase() !== "k"
      )
        return;
      event.preventDefault();
      setSearchOpen(true);
    }
    window.addEventListener("keydown", openGlobalSearch);
    return () => window.removeEventListener("keydown", openGlobalSearch);
  }, [setSearchOpen, surfaceRef]);

  // ⌥⌘U, the shortcut Codex gives its activity view. Read from `code` because
  // Option turns the key into a dead key on macOS, so `key` is not "u".
  useEffect(() => {
    function onInboxShortcut(event: globalThis.KeyboardEvent): void {
      if (
        !event.metaKey ||
        !event.altKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.code !== "KeyU" ||
        surfaceRef.current === "terminal"
      )
        return;
      event.preventDefault();
      toggleInbox();
    }
    window.addEventListener("keydown", onInboxShortcut);
    return () => window.removeEventListener("keydown", onInboxShortcut);
  }, [surfaceRef, toggleInbox]);
}
