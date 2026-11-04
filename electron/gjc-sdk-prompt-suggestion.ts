import type { GjcSetting } from "../shared/gjc-settings.js";
import { listGjcSettings } from "./gjc-config.js";

/**
 * Next-input suggestions for the app composer.
 *
 * GJC computes these only inside its terminal TUI (`utils/prompt-suggestion.ts`,
 * ported there from the OpenAI Codex TUI, openai/codex#47911 and #47929); the SDK
 * has no operation for them. `btw.ask` is the nearest existing one: an ephemeral
 * answer from the session's own model, system prompt and visible-text history that
 * owns no turn and writes nothing to the transcript. The request text and the strict
 * reply contract below are GJC's, kept verbatim so both surfaces behave alike.
 */

/** GJC `prompts/system/prompt-suggestion.md`, unchanged. */
export const PROMPT_SUGGESTION_REQUEST = `<external_prompt_suggestion>This is an app-generated request for a suggested next user message. The user did not write this message.

Your suggestion will appear in the user's empty message composer. They can accept it, edit it, or ignore it; it will not be sent automatically.

Predict this user's next message from the whole conversation. Before choosing a new content question, consider whether they want an operation on material already produced. The object may be the assistant's own answer, a draft, a list, a comparison, or an external artifact. They may want to reuse it in a different form, make it easier to read or copy, obtain more items of the same kind, retry an earlier response after discussing its flaw, or make one precise change. Choose such a move only when the user's purpose, prior reactions, or intended use supports it. Preserve the actual object and requested deliverable; an adjacent explanation or extra content is a different action. If no transformation is supported, choose the strongest grounded question, reply, or continuation. Keep the necessary linked requirements, without inventing observations or a new agenda. Set suggestion to exactly one natural message in the user's voice, one line, at most 240 characters. No alternatives or explanation. Prefer a grounded prediction; use null only if every concrete next move is arbitrary.

Return only JSON matching this schema: {"type":"object","properties":{"suggestion":{"type":["string","null"]}},"required":["suggestion"],"additionalProperties":false}.</external_prompt_suggestion>`;

export const PROMPT_SUGGESTION_MAX_CHARS = 240;

/** Codex cancels a suggestion that has not arrived within 30 seconds. */
export const PROMPT_SUGGESTION_TIMEOUT_MS = 30_000;

/** Control characters and Unicode line or paragraph separators break the one-line contract. */
const NON_SINGLE_LINE = /[\p{Cc}\u2028\u2029]/u;

/** An unpaired surrogate is a serde error in Codex, so it is no suggestion here. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Rust `str::trim` strips Unicode White_Space (U+0085 included, U+FEFF excluded), unlike `String#trim`. */
const EDGE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/**
 * True when the top-level object has more than one member. serde with
 * `deny_unknown_fields` rejects unknown and duplicate fields, while `JSON.parse`
 * silently collapses duplicates. Only called on text that already parsed.
 */
function hasMultipleTopLevelMembers(json: string): boolean {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (char === "," && depth === 1) return true;
  }
  return false;
}

/**
 * Accepts only an object whose sole key is `suggestion` holding a non-empty,
 * single-line string of at most 240 characters, which is returned trimmed.
 * Anything else, `{"suggestion": null}` included, is no suggestion.
 *
 * `btw.ask` frames the request as a side-chat question, where a model may wrap
 * its JSON in one code fence; that fence alone is unwrapped.
 */
export function parsePromptSuggestion(answer: string): string | null {
  const reply = /^\s*```(?:json)?[ \t]*\n([\s\S]*?)\n```\s*$/u.exec(answer)?.[1] ?? answer;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "suggestion") return null;
  if (hasMultipleTopLevelMembers(reply)) return null;
  const value = (parsed as { suggestion: unknown }).suggestion;
  if (typeof value !== "string" || LONE_SURROGATE.test(value)) return null;
  const text = value.replace(EDGE_WHITE_SPACE, "");
  if (text.length === 0 || [...text].length > PROMPT_SUGGESTION_MAX_CHARS || NON_SINGLE_LINE.test(text))
    return null;
  return text;
}

export interface PromptSuggestionHost {
  /** The `promptSuggestions` GJC setting: off means no model call at all. */
  promptSuggestionsEnabled(): Promise<boolean>;
  sdkOperations(sessionId: string): Promise<Set<string>>;
  controlSession(
    sessionId: string,
    operation: "btw.ask",
    input: { question: string },
    options: { timeoutMs: number },
  ): Promise<Record<string, unknown> | undefined>;
}

/**
 * Asks the session's model for the user's likely next message.
 *
 * A failure, a runtime without `btw.ask`, or a reply outside the contract is "no
 * suggestion", never an error: the composer shows nothing and the user is not told
 * about a feature they did not ask for in that moment.
 */
export async function suggestNextInput(
  host: PromptSuggestionHost,
  sessionId: string,
): Promise<string | null> {
  if (!(await host.promptSuggestionsEnabled())) return null;
  if (!(await host.sdkOperations(sessionId)).has("btw.ask")) return null;
  try {
    const result = await host.controlSession(
      sessionId,
      "btw.ask",
      { question: PROMPT_SUGGESTION_REQUEST },
      { timeoutMs: PROMPT_SUGGESTION_TIMEOUT_MS },
    );
    return typeof result?.reply === "string" ? parsePromptSuggestion(result.reply) : null;
  } catch {
    return null;
  }
}

const SETTING_TTL_MS = 30_000;

/**
 * The `promptSuggestions` value from `gjc config list`, read once and reused.
 *
 * Applying settings in the app drops the cached value. A change made in a terminal
 * is picked up when the entry expires. An unreadable listing counts as off, because
 * the feature costs a model call the user opted into explicitly.
 */
export class PromptSuggestionSetting {
  private cached?: { at: number; value: Promise<boolean> };

  constructor(
    private readonly executable: () => Promise<string>,
    private readonly now: () => number = Date.now,
    private readonly list: (executable: string) => Promise<GjcSetting[]> = listGjcSettings,
  ) {}

  enabled(): Promise<boolean> {
    const cached = this.cached;
    if (cached && this.now() - cached.at < SETTING_TTL_MS) return cached.value;
    const value = this.executable()
      .then((executable) => this.list(executable))
      .then((settings) => settings.find((setting) => setting.key === "promptSuggestions")?.value === true)
      .catch(() => false);
    this.cached = { at: this.now(), value };
    return value;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}
