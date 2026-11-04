/**
 * The composer's next-input suggestion as a state machine.
 *
 * A suggestion is `idle`, waiting on one request (`pending`), or on screen
 * (`shown`). It belongs to the session it was asked for. Every state carries the
 * request that produced it, so a late answer for a request that has been replaced,
 * dropped or timed out finds a different state and is discarded.
 */

/** GJC gives up on a suggestion that has not arrived after 30 seconds. */
export const SUGGESTION_TIMEOUT_MS = 30_000;

export type SuggestionState =
  | { kind: "idle" }
  | { kind: "pending"; sessionId: string; requestId: number }
  | { kind: "shown"; sessionId: string; requestId: number; text: string };

export type SuggestionEvent =
  | { type: "request"; sessionId: string; requestId: number }
  | { type: "result"; requestId: number; text: string | null }
  | { type: "expire"; requestId: number }
  | { type: "drop" };

export const IDLE_SUGGESTION: SuggestionState = { kind: "idle" };

export function suggestionReducer(
  state: SuggestionState,
  event: SuggestionEvent,
): SuggestionState {
  switch (event.type) {
    case "request":
      return { kind: "pending", sessionId: event.sessionId, requestId: event.requestId };
    case "result":
      if (state.kind !== "pending" || state.requestId !== event.requestId) return state;
      return event.text === null
        ? IDLE_SUGGESTION
        : { kind: "shown", sessionId: state.sessionId, requestId: state.requestId, text: event.text };
    case "expire":
      return state.kind === "pending" && state.requestId === event.requestId
        ? IDLE_SUGGESTION
        : state;
    case "drop":
      return state.kind === "idle" ? state : IDLE_SUGGESTION;
  }
}

/** What the composer looks like right now, as far as a suggestion cares. */
export interface SuggestionContext {
  sessionId: string;
  /** The textarea holds nothing at all, whitespace included. */
  draftEmpty: boolean;
  hasAttachments: boolean;
  /** Requests are held in the composer's queue. */
  queued: boolean;
  /** A turn is live: the one the suggestion followed has been replaced. */
  running: boolean;
  /** The slash or mention popup is open. */
  popupOpen: boolean;
  readOnly: boolean;
}

/** True when nothing about the composer rules a suggestion out. */
export function composerAcceptsSuggestion(context: SuggestionContext): boolean {
  return (
    context.draftEmpty &&
    !context.hasAttachments &&
    !context.queued &&
    !context.running &&
    !context.popupOpen &&
    !context.readOnly
  );
}

/** A suggestion that has stopped applying: another session, or a busy composer. */
export function suggestionObsolete(
  state: SuggestionState,
  context: SuggestionContext,
): boolean {
  return (
    state.kind !== "idle" &&
    (state.sessionId !== context.sessionId || !composerAcceptsSuggestion(context))
  );
}

export interface WindowActivity {
  visibilityState: string;
  hasFocus(): boolean;
}

/**
 * A suggestion costs one more call to the session's model, so it is only worth
 * asking for when someone is looking: the window is visible and focused.
 */
export function windowIsAttended(activity: WindowActivity): boolean {
  return activity.visibilityState === "visible" && activity.hasFocus();
}
