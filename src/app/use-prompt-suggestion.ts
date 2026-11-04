import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  composerAcceptsSuggestion,
  IDLE_SUGGESTION,
  SUGGESTION_TIMEOUT_MS,
  suggestionObsolete,
  suggestionReducer,
  windowIsAttended,
} from "./prompt-suggestion";
import type { SuggestionContext, WindowActivity } from "./prompt-suggestion";

export interface PromptSuggestionOptions {
  context: SuggestionContext;
  /** Absent when the backend cannot suggest: nothing is ever requested. */
  request?: (sessionId: string) => Promise<string | null>;
  /** Injected by tests; defaults to the document. */
  activity?: () => WindowActivity;
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
  activity = () => document,
}: PromptSuggestionOptions): PromptSuggestion {
  const [state, dispatch] = useReducer(suggestionReducer, IDLE_SUGGESTION);
  const contextRef = useRef(context);
  contextRef.current = context;
  const requestRef = useRef(request);
  requestRef.current = request;
  const activityRef = useRef(activity);
  activityRef.current = activity;
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
    const ask = requestRef.current;
    const current = contextRef.current;
    if (!ask || !composerAcceptsSuggestion(current) || !windowIsAttended(activityRef.current()))
      return;
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
  const textRef = useRef(text);
  textRef.current = text;

  const accept = useCallback((): string | null => {
    const accepted = textRef.current;
    if (accepted !== null) dispatch({ type: "drop" });
    return accepted;
  }, []);
  const dismiss = useCallback(() => dispatch({ type: "drop" }), []);

  return { text, trigger, accept, dismiss };
}
