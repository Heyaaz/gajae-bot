import type { AgentSession } from "./agent-contract.js";

/**
 * How the app reaches outside its window: power management, the menu bar, the Dock
 * and global input.
 *
 * Saved through a field-only channel like the notification settings, because none
 * of it changes what the runtime does and a toggle must not raise the runtime
 * settings confirmation.
 */
export interface DesktopIntegrationPreferences {
  /**
   * Keep the Mac from sleeping while a session is working.
   *
   * Only held while a turn runs: a sleeping Mac pauses the broker host, and a long
   * goal or automation would otherwise stop halfway with nobody watching.
   */
  preventSleep: boolean;
}

export const DEFAULT_DESKTOP_INTEGRATION: DesktopIntegrationPreferences = {
  preventSleep: true,
};

/**
 * Fills a missing or malformed field from the defaults.
 *
 * A settings file written before this group existed has no key at all, and a
 * hand-edited one may hold junk; neither may fail the whole settings load.
 */
export function parseDesktopIntegration(
  value: unknown,
): DesktopIntegrationPreferences {
  const candidate =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    preventSleep:
      typeof candidate.preventSleep === "boolean"
        ? candidate.preventSleep
        : DEFAULT_DESKTOP_INTEGRATION.preventSleep,
  };
}

/**
 * What a session is doing for the user.
 *
 * Shared by the rail, the main process (power, menu bar, Dock) and the inbox so
 * "working" and "needs input" mean the same thing on every surface.
 */
export type SessionAttentionGroup = "needs-input" | "working" | "completed";

export function sessionAttentionGroup(
  session: Pick<AgentSession, "status" | "phase">,
): SessionAttentionGroup {
  // Compaction outlives the turn that started it, so a session reported idle
  // while its context is still being compacted is doing work. Ranking it done put
  // the row in a finished group a moment before it moved back out.
  if (session.phase === "compacting") return "working";
  // There is no "it failed" group: a failure is something the user has to look
  // at, which is the same job as an approval request.
  if (session.status === "failed" || session.status === "waiting")
    return "needs-input";
  if (session.status === "running" || session.status === "starting")
    return "working";
  return "completed";
}

export interface SessionAttention {
  working: number;
  needsInput: number;
  /** Finished sessions with activity the user has not looked at. */
  unreadCompleted: number;
}

export function summarizeSessionAttention(
  sessions: Iterable<Pick<AgentSession, "status" | "phase" | "unread">>,
): SessionAttention {
  const attention: SessionAttention = {
    working: 0,
    needsInput: 0,
    unreadCompleted: 0,
  };
  for (const session of sessions) {
    const group = sessionAttentionGroup(session);
    if (group === "working") attention.working += 1;
    else if (group === "needs-input") attention.needsInput += 1;
    else if (session.unread) attention.unreadCompleted += 1;
  }
  return attention;
}
