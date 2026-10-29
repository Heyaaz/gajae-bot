export const SETTINGS_IPC = {
  getPreferences: "agent-control:settings:get-preferences",
  chooseWorkspace: "agent-control:settings:choose-workspace",
  prepareImages: "agent-control:settings:prepare-images",
  prepareFiles: "agent-control:settings:prepare-files",
  discardAttachments: "agent-control:settings:discard-attachments",
  setWorkspaceLabel: "agent-control:settings:set-workspace-label",
  setThoughtsExpanded: "agent-control:settings:set-thoughts-expanded",
  setToolViewMode: "agent-control:settings:set-tool-view-mode",
  setNotificationPreferences:
    "agent-control:settings:set-notification-preferences",
  setDesktopIntegration: "agent-control:settings:set-desktop-integration",
  setLanguage: "agent-control:settings:set-language",
  setRunningSubmission: "agent-control:settings:set-running-submission",
  setViewedSession: "agent-control:settings:set-viewed-session",
  savePreferences: "agent-control:settings:save-preferences",
  checkGjcUpdate: "agent-control:settings:check-gjc-update",
  installGjcUpdate: "agent-control:settings:install-gjc-update",
} as const;

export const DESKTOP_IPC = {
  cycleEffort: "gajae:shortcut:cycle-effort",
  abortRun: "gajae:shortcut:abort-run",
  sessionShortcut: "gajae:shortcut:session",
} as const;

/** Values the new-session dialog opens with. The prompt is only ever placed in the composer, never sent. */
export type NewSessionPrefill = {
  workspace?: string;
  title?: string;
  prompt?: string;
  isolation?: "workspace" | "worktree";
  worktreeBranch?: string;
};

/**
 * `new` without a prefill creates a session at once (⌘T). With a prefill it opens
 * the dialog instead, so text that arrived from outside waits for the user.
 */
export type SessionShortcut =
  | { type: "new"; prefill?: NewSessionPrefill }
  | { type: "open"; sessionId: string }
  | { type: "select"; index: number }
  | { type: "abort" };

export function sessionShortcutForInput(input: {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}): SessionShortcut | undefined {
  if (input.type !== "keyDown") return undefined;
  if (
    !input.meta &&
    !input.control &&
    !input.alt &&
    !input.shift &&
    isEscapeKey(input.key)
  ) {
    return { type: "abort" };
  }
  if (!input.meta || input.control || input.alt || input.shift)
    return undefined;
  if (input.key.toLowerCase() === "t") return { type: "new" };
  if (/^[1-9]$/u.test(input.key))
    return { type: "select", index: Number(input.key) - 1 };
  return undefined;
}

export function isEscapeKey(key: string): boolean {
  return key === "Escape" || key === "Esc";
}
