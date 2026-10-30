/**
 * Asks a yes/no question in the host's own confirmation dialog, the one every
 * host-guarded action uses. A browser without the desktop host falls back to the
 * page's confirm.
 */
export async function confirmChoice(message: string, detail?: string): Promise<boolean> {
  const settings = typeof window === "undefined" ? undefined : window.agentControlDesktop?.settings;
  if (!settings) return window.confirm(detail ? `${message}\n\n${detail}` : message);
  return settings.confirm(message, detail);
}
