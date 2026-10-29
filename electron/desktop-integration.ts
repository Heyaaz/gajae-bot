import type { AgentEvent, AgentSession } from "../shared/agent-contract.js";
import {
  summarizeSessionAttention,
  type DesktopIntegrationPreferences,
  type SessionAttention,
} from "../shared/desktop-integration.js";

/** The slice of Electron's `powerSaveBlocker` this module uses, so tests can fake it. */
export interface PowerSaveApi {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export type TrackedSession = Pick<
  AgentSession,
  "id" | "title" | "workspace" | "status" | "phase" | "unread" | "updatedAtMs"
>;

export interface DesktopIntegrationOptions {
  power: PowerSaveApi;
  preferences: DesktopIntegrationPreferences;
  /** Called after any change to the tracked sessions or the preferences. */
  onChange?: (state: DesktopIntegrationState) => void;
}

export interface DesktopIntegrationState {
  attention: SessionAttention;
  sessions: readonly TrackedSession[];
  preferences: DesktopIntegrationPreferences;
}

/**
 * Main-process view of what the sessions are doing, for the surfaces outside the
 * window: power management now, the menu bar and Dock badge on top of it.
 *
 * It follows the same event stream the windows read rather than polling the
 * runtime, so the badge and the rail cannot disagree about a session.
 */
export class DesktopIntegration {
  private readonly sessions = new Map<string, TrackedSession>();
  private preferences: DesktopIntegrationPreferences;
  private blockerId: number | undefined;
  private disposed = false;

  constructor(private readonly options: DesktopIntegrationOptions) {
    this.preferences = options.preferences;
  }

  /** Rows the runtime already had before this process subscribed to its events. */
  seed(sessions: readonly AgentSession[]): void {
    for (const session of sessions)
      if (!this.sessions.has(session.id)) this.sessions.set(session.id, track(session));
    this.reconcile();
  }

  observe(event: AgentEvent): void {
    if (event.type === "session.created" || event.type === "session.updated") {
      this.sessions.set(event.session.id, track(event.session));
    } else if (event.type === "session.deleted") {
      this.sessions.delete(event.sessionId);
    } else if (event.type === "session.activity") {
      // Activity carries the unread flag without a full row; the next row update
      // would bring it too, but the badge should not wait for that.
      const current = this.sessions.get(event.sessionId);
      if (!current || current.unread === event.unread) return;
      this.sessions.set(event.sessionId, { ...current, unread: event.unread });
    } else {
      return;
    }
    this.reconcile();
  }

  setPreferences(preferences: DesktopIntegrationPreferences): void {
    this.preferences = preferences;
    this.reconcile();
  }

  state(): DesktopIntegrationState {
    return {
      attention: summarizeSessionAttention(this.sessions.values()),
      sessions: [...this.sessions.values()],
      preferences: this.preferences,
    };
  }

  /** Whether this process currently holds the sleep assertion. */
  preventingSleep(): boolean {
    return (
      this.blockerId !== undefined && this.options.power.isStarted(this.blockerId)
    );
  }

  dispose(): void {
    this.disposed = true;
    this.releaseBlocker();
  }

  private reconcile(): void {
    if (this.disposed) return;
    const state = this.state();
    const wantBlocker =
      this.preferences.preventSleep && state.attention.working > 0;
    if (wantBlocker && !this.preventingSleep()) {
      this.blockerId = this.options.power.start("prevent-app-suspension");
    } else if (!wantBlocker) {
      this.releaseBlocker();
    }
    this.options.onChange?.(state);
  }

  private releaseBlocker(): void {
    if (this.blockerId === undefined) return;
    if (this.options.power.isStarted(this.blockerId))
      this.options.power.stop(this.blockerId);
    this.blockerId = undefined;
  }
}

function track(session: AgentSession): TrackedSession {
  return {
    id: session.id,
    title: session.title,
    workspace: session.workspace,
    status: session.status,
    phase: session.phase,
    unread: session.unread,
    updatedAtMs: session.updatedAtMs,
  };
}
