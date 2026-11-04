import { describe, expect, it } from "vitest";
import {
  composerAcceptsSuggestion,
  IDLE_SUGGESTION,
  suggestionObsolete,
  suggestionReducer,
  windowIsAttended,
} from "./prompt-suggestion";
import type { SuggestionContext, SuggestionEvent, SuggestionState } from "./prompt-suggestion";

function run(events: SuggestionEvent[], from: SuggestionState = IDLE_SUGGESTION): SuggestionState {
  return events.reduce(suggestionReducer, from);
}

const ready: SuggestionContext = {
  sessionId: "s1",
  draftEmpty: true,
  hasAttachments: false,
  queued: false,
  running: false,
  popupOpen: false,
  readOnly: false,
};

describe("suggestion state machine", () => {
  it("goes idle, pending, shown", () => {
    expect(run([{ type: "request", sessionId: "s1", requestId: 1 }])).toEqual({
      kind: "pending",
      sessionId: "s1",
      requestId: 1,
    });
    expect(
      run([
        { type: "request", sessionId: "s1", requestId: 1 },
        { type: "result", requestId: 1, text: "다음 단계" },
      ]),
    ).toEqual({ kind: "shown", sessionId: "s1", requestId: 1, text: "다음 단계" });
  });

  it("returns to idle on a null suggestion", () => {
    expect(
      run([
        { type: "request", sessionId: "s1", requestId: 1 },
        { type: "result", requestId: 1, text: null },
      ]),
    ).toBe(IDLE_SUGGESTION);
  });

  it("discards the late result of a superseded request", () => {
    const state = run([
      { type: "request", sessionId: "s1", requestId: 1 },
      { type: "request", sessionId: "s1", requestId: 2 },
      { type: "result", requestId: 1, text: "stale" },
    ]);
    expect(state).toEqual({ kind: "pending", sessionId: "s1", requestId: 2 });
    expect(run([{ type: "result", requestId: 2, text: "fresh" }], state)).toMatchObject({
      kind: "shown",
      text: "fresh",
    });
  });

  it("discards a result that arrives after the suggestion was dropped", () => {
    expect(
      run([
        { type: "request", sessionId: "s1", requestId: 1 },
        { type: "drop" },
        { type: "result", requestId: 1, text: "late" },
      ]),
    ).toBe(IDLE_SUGGESTION);
  });

  it("does not let a result replace a suggestion already shown", () => {
    const shown = run([
      { type: "request", sessionId: "s1", requestId: 1 },
      { type: "result", requestId: 1, text: "first" },
    ]);
    expect(run([{ type: "result", requestId: 1, text: "second" }], shown)).toBe(shown);
  });

  it("expires only the pending request it was started for", () => {
    const pending = run([{ type: "request", sessionId: "s1", requestId: 2 }]);
    expect(run([{ type: "expire", requestId: 1 }], pending)).toBe(pending);
    expect(run([{ type: "expire", requestId: 2 }], pending)).toBe(IDLE_SUGGESTION);
    const shown = run([{ type: "result", requestId: 2, text: "keep" }], pending);
    expect(run([{ type: "expire", requestId: 2 }], shown)).toBe(shown);
  });

  it("drops a shown suggestion", () => {
    const shown = run([
      { type: "request", sessionId: "s1", requestId: 1 },
      { type: "result", requestId: 1, text: "x" },
    ]);
    expect(run([{ type: "drop" }], shown)).toBe(IDLE_SUGGESTION);
  });
});

describe("what makes a suggestion obsolete", () => {
  const shown: SuggestionState = { kind: "shown", sessionId: "s1", requestId: 1, text: "x" };
  const pending: SuggestionState = { kind: "pending", sessionId: "s1", requestId: 1 };

  it("keeps a suggestion for a ready composer in the same session", () => {
    expect(suggestionObsolete(shown, ready)).toBe(false);
    expect(suggestionObsolete(pending, ready)).toBe(false);
  });

  it.each<[string, Partial<SuggestionContext>]>([
    ["typing or a non-empty draft", { draftEmpty: false }],
    ["an attachment added", { hasAttachments: true }],
    ["a held request", { queued: true }],
    ["a new turn starting", { running: true }],
    ["the slash or mention popup opening", { popupOpen: true }],
    ["a view-only device", { readOnly: true }],
    ["a session switch", { sessionId: "s2" }],
  ])("drops both pending and shown on %s", (_name, change) => {
    const context = { ...ready, ...change };
    expect(suggestionObsolete(shown, context)).toBe(true);
    expect(suggestionObsolete(pending, context)).toBe(true);
  });

  it("never marks idle obsolete", () => {
    expect(suggestionObsolete(IDLE_SUGGESTION, { ...ready, draftEmpty: false })).toBe(false);
  });

  it("only a clean composer accepts a request", () => {
    expect(composerAcceptsSuggestion(ready)).toBe(true);
    expect(composerAcceptsSuggestion({ ...ready, queued: true })).toBe(false);
  });
});

describe("window attention", () => {
  it("needs a visible and focused window", () => {
    expect(windowIsAttended({ visibilityState: "visible", hasFocus: () => true })).toBe(true);
    expect(windowIsAttended({ visibilityState: "hidden", hasFocus: () => true })).toBe(false);
    expect(windowIsAttended({ visibilityState: "visible", hasFocus: () => false })).toBe(false);
  });
});
