import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import {
  composerAcceptsSuggestion,
  IDLE_SUGGESTION,
  SUGGESTION_TIMEOUT_MS,
  suggestionObsolete,
  suggestionReducer,
  windowIsAttended,
} from "./prompt-suggestion";
import type { SuggestionContext } from "./prompt-suggestion";

export interface PromptSuggestionOptions {
  context: SuggestionContext;
  /** Absent when the backend cannot suggest: nothing is ever requested. */
  request?: (sessionId: string) => Promise<string | null>;
}

export interface PromptSuggestion {
  /** The ghost text to show, only while it still applies. */
  text: string | null;
  /** Asks for a suggestion after a turn ended normally. */
  trigger: () => void;
  /** Hands the suggestion over for the draft and clears it. */
  accept: () => string | null;
  dismiss: () => void;
}

export function usePromptSuggestion({
  context,
  request,
}: PromptSuggestionOptions): PromptSuggestion {
  const [state, dispatch] = useReducer(suggestionReducer, IDLE_SUGGESTION);
  // The async callbacks below read what the last committed render saw.
  const latest = useRef({ context, request, text: null as string | null });
  const nextRequestId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const obsolete = suggestionObsolete(state, context);
  useEffect(() => {
    if (obsolete) dispatch({ type: "drop" });
  }, [obsolete, state]);
  useEffect(() => {
    if (state.kind !== "pending") clearTimeout(timer.current);
  }, [state.kind]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const trigger = useCallback(() => {
    const { context: current, request: ask } = latest.current;
    if (!ask || !composerAcceptsSuggestion(current) || !windowIsAttended(document)) return;
    const requestId = (nextRequestId.current += 1);
    dispatch({ type: "request", sessionId: current.sessionId, requestId });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => dispatch({ type: "expire", requestId }), SUGGESTION_TIMEOUT_MS);
    ask(current.sessionId).then(
      (text) => dispatch({ type: "result", requestId, text }),
      () => dispatch({ type: "result", requestId, text: null }),
    );
  }, []);

  const text = state.kind === "shown" && !obsolete ? state.text : null;
  useLayoutEffect(() => {
    latest.current = { context, request, text };
  });

  const accept = useCallback((): string | null => {
    const accepted = latest.current.text;
    if (accepted !== null) dispatch({ type: "drop" });
    return accepted;
  }, []);
  const dismiss = useCallback(() => dispatch({ type: "drop" }), []);

  return { text, trigger, accept, dismiss };
}
