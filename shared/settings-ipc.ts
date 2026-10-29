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

export type SessionShortcut =
  { type: "new" } | { type: "select"; index: number } | { type: "abort" };

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
