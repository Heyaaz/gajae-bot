/** The `@token` the caret is in, as offsets into the draft. */
export interface MentionToken {
  /** Offset of the `@`. */
  start: number;
  /** Offset just past the token. */
  end: number;
  /** The text after `@`, as typed. */
  query: string;
}

/**
 * The mention the caret is editing, if any.
 *
 * A mention starts at an `@` that opens the draft or follows whitespace, so an
 * address such as `me@example.com` never opens the file popup, and runs to the
 * next whitespace. The slash palette only matches a draft with no whitespace that
 * starts with `/`, so the two popups can never claim the same keystroke.
 */
export function activeMention(value: string, caret: number): MentionToken | null {
  let start = caret;
  while (start > 0 && !/\s/u.test(value[start - 1]!)) start -= 1;
  if (value[start] !== "@") return null;
  let end = caret;
  while (end < value.length && !/\s/u.test(value[end]!)) end += 1;
  return { start, end, query: value.slice(start + 1, end) };
}

/** The draft once a chosen mention has become a chip, and where the caret goes. */
export function withoutMention(
  value: string,
  token: MentionToken,
): { value: string; caret: number } {
  const before = value.slice(0, token.start);
  let after = value.slice(token.end);
  // Removing the token from `look at @ren please` would leave a double space.
  if ((before === "" || /\s$/u.test(before)) && after.startsWith(" "))
    after = after.slice(1);
  return { value: before + after, caret: before.length };
}

/** A file list prepared once so each keystroke only scans lower-cased strings. */
export interface MentionCandidates {
  paths: readonly string[];
  lower: readonly string[];
  /** Offset of the file name inside each path. */
  nameStart: readonly number[];
}

export function mentionCandidates(paths: readonly string[]): MentionCandidates {
  return {
    paths,
    lower: paths.map((value) => value.toLowerCase()),
    nameStart: paths.map((value) => value.lastIndexOf("/") + 1),
  };
}

// How a path matched, best first. A file-name prefix is what `@ren` usually means.
const NAME_PREFIX = 0;
const NAME_SUBSTRING = 1;
const PATH_SUBSTRING = 2;
const NAME_SUBSEQUENCE = 3;
const PATH_SUBSEQUENCE = 4;

/**
 * The cost of the letters of `query` appearing in order inside `text` from
 * `from`, or -1 when they do not. Skipped characters cost, and a letter that
 * lands right after a separator costs less than one in the middle of a word, so
 * `cmp` ranks `composer-mentions` above `scrumpy`.
 */
function subsequenceCost(text: string, query: string, from: number): number {
  let cost = 0;
  let position = from;
  for (const letter of query) {
    const found = text.indexOf(letter, position);
    if (found < 0) return -1;
    cost += found - position;
    const previous = found === 0 ? "/" : text[found - 1]!;
    if (!"/-_. ".includes(previous)) cost += 1;
    position = found + 1;
  }
  return cost;
}

/** Tier, then match quality, then shorter paths. Lower is better. */
function matchCost(candidates: MentionCandidates, index: number, query: string): number {
  const text = candidates.lower[index]!;
  const nameStart = candidates.nameStart[index]!;
  const length = text.length;
  const rank = (tier: number, quality: number): number =>
    tier * 1e9 + quality * 1e4 + length;
  const inName = text.indexOf(query, nameStart);
  if (inName === nameStart) return rank(NAME_PREFIX, 0);
  if (inName >= 0) return rank(NAME_SUBSTRING, inName - nameStart);
  const inPath = text.indexOf(query);
  if (inPath >= 0) return rank(PATH_SUBSTRING, inPath);
  const nameCost = subsequenceCost(text, query, nameStart);
  if (nameCost >= 0) return rank(NAME_SUBSEQUENCE, nameCost);
  const pathCost = subsequenceCost(text, query, 0);
  if (pathCost >= 0) return rank(PATH_SUBSEQUENCE, pathCost);
  return -1;
}

/**
 * The best `limit` paths for a query, best first.
 *
 * Only the kept window is ever sorted, so a large repository costs one pass over
 * its paths per keystroke instead of a sort of every match. Whitespace never
 * reaches here: it ends the mention. An empty query lists the shallowest paths.
 */
export function rankMentionCandidates(
  candidates: MentionCandidates,
  query: string,
  limit: number,
): string[] {
  const needle = query.toLowerCase();
  const kept: Array<{ cost: number; index: number }> = [];
  for (let index = 0; index < candidates.paths.length; index += 1) {
    const cost = needle
      ? matchCost(candidates, index, needle)
      : candidates.nameStart[index]! * 1e4 + candidates.lower[index]!.length;
    if (cost < 0) continue;
    if (kept.length === limit && cost >= kept[limit - 1]!.cost) continue;
    let slot = kept.length;
    while (slot > 0 && kept[slot - 1]!.cost > cost) slot -= 1;
    kept.splice(slot, 0, { cost, index });
    if (kept.length > limit) kept.pop();
  }
  return kept.map((entry) => candidates.paths[entry.index]!);
}

export type MentionKeyAction = "next" | "previous" | "choose" | "dismiss" | "swallow";

/**
 * What one keydown means while the mention popup is open, or `null` to leave the
 * key to the rest of the composer.
 *
 * Nothing in the popup reacts while the IME is composing: the Korean IME delivers
 * Enter (and the arrows) to finish the open syllable, and that Enter is swallowed
 * here so it neither chooses a file nor arms the composer's send. The second
 * delivery of the same physical Enter, right after the commit, is swallowed too.
 * Esc closes the popup and must not reach the composer, where it stops the run.
 */
export function mentionKeyAction(
  event: {
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    composing: boolean;
    /** The keydown landed inside the IME follow-up window after a commit. */
    afterCommit: boolean;
  },
  hasCandidates: boolean,
): MentionKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.composing)
    return event.key === "Enter" && !event.shiftKey ? "swallow" : null;
  if (event.key === "Escape" || event.key === "Esc") return "dismiss";
  if (event.key === "Enter" && !event.shiftKey && event.afterCommit) return "swallow";
  if (!hasCandidates) return null;
  if (event.key === "ArrowDown") return "next";
  if (event.key === "ArrowUp") return "previous";
  if ((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && !event.shiftKey))
    return "choose";
  return null;
}
