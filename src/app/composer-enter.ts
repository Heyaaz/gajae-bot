import { IME_FOLLOWUP_WINDOW_MS } from "../composer-utils";

/**
 * The draft a selected palette command leaves in the composer.
 *
 * The trailing space is not cosmetic. The palette matches the bare `/name` query,
 * so leaving the textarea on exactly the value that was selected kept the match
 * alive and the next Enter re-selected the command instead of submitting it. Only
 * commands that still need input reach this line -- a hint-less command without the
 * `skill:` prefix was executed and returned above, and `skill:*` is agent work that
 * has to stay a draft -- so the space is unconditional.
 */
export function selectedCommandDraft(name: string): string {
  return `/${name} `;
}

/**
 * The composer state one Enter keydown is decided against, and nothing else the
 * textarea's keydown handler deals with.
 *
 * The Enter paths are split out of that handler so the contract -- including the
 * Shift+Enter newline, which has to leave the keydown to the textarea -- can be
 * driven directly in tests the way the sidebar's Escape consumer is.
 */
export interface ComposerEnterEvent {
  key: string;
  /** Shift+Enter is always a newline, never a submit. */
  shiftKey: boolean;
  /** Any of the signals the Korean IME raises while its last syllable is open. */
  composing: boolean;
  /** When the last composition commit landed, in `performance.now()` time. */
  compositionEndedAt: number;
  /** `performance.now()` for this keydown. */
  now: number;
  /** The textarea holds nothing but whitespace. */
  draftEmpty: boolean;
  /** The slash-command palette is open and owns a settled Enter. */
  paletteOpen: boolean;
}

export interface ComposerEnterEffects {
  preventDefault: () => void;
  /** Send the draft, or hold it behind the queue -- everything Enter means. */
  submit: () => void;
  /** Hold this Enter until the composition it landed in commits. */
  arm: (at: number) => void;
  /** Forget an armed Enter so a later commit cannot submit on its behalf. */
  disarm: () => void;
  /** Submit once the frame that ends the current composition has run. */
  defer: () => void;
}

/**
 * Apply one Enter keydown to the composer, returning whether it was consumed.
 *
 * Shift+Enter is the one path that is never consumed: it leaves the keydown
 * un-prevented so the textarea inserts the newline and the autosize picks up the
 * taller draft. That has to hold mid-composition too -- the IME delivers a plain
 * Enter while the final syllable is still open, and treating that same signal as a
 * submit on Shift+Enter queued the text the user was only making a line break in.
 * An Enter armed by an earlier keypress is dropped here as well: the commit that
 * follows this keystroke is the IME closing *this* line, not finishing that submit.
 *
 * A plain Enter keeps its two IME paths (arm now, submit from the commit; submit
 * from the follow-up keydown right after a commit) and its two settled meanings
 * (the palette's selection, or send/hold depending on the turn).
 */
export function handleComposerEnter(
  event: ComposerEnterEvent,
  effects: ComposerEnterEffects,
): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey) {
    effects.disarm();
    return false;
  }
  // macOS Korean IME emits Enter while the final syllable is still composing.
  // Treating that keydown as submit sends the full sentence and then the last
  // syllable again as a second steer (for example "steer 테스트" + "트"), so the
  // submission waits for the IME to commit. It is armed here and fired from
  // compositionend, which is the first moment the final text is readable.
  if (event.composing) {
    effects.preventDefault();
    // An empty draft has nothing left to compose, so this is a real empty
    // submit -- the gesture that interrupts the run and releases the queue.
    if (event.draftEmpty) {
      effects.disarm();
      effects.submit();
      return true;
    }
    effects.arm(event.now);
    return true;
  }
  // One physical Enter can reach the handler twice around a commit: once while
  // the composition still owns it (armed above) and once after the commit has
  // landed. Both are the same submission, so the second only defers to the frame
  // the commit scheduled.
  if (event.now - event.compositionEndedAt < IME_FOLLOWUP_WINDOW_MS) {
    effects.preventDefault();
    if (!event.draftEmpty) effects.defer();
    return true;
  }
  // The palette selects its highlighted command rather than sending the query.
  if (event.paletteOpen) return false;
  effects.preventDefault();
  effects.submit();
  return true;
}

