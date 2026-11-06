/** A deep-interview round header such as `Round 0 | Topology | Ambiguity: 5%`. */
const ROUND_HEADER = /^Round\s+\d+\s*\|/iu;
const LIST_ITEM = /^(?:[-*•]|\d+[.)])\s/u;

interface QuestionParts {
  /** The round header split at its `|` separators, or empty. */
  meta: string[];
  /** Everything between the header and the ask, line breaks kept. */
  context: string;
  /** The line the person answers. */
  ask: string;
}

/**
 * Splits a multi-line prompt into its round header, its context, and the
 * closing ask, so the ask stands out from the listing above it.
 */
export function questionParts(text: string): QuestionParts {
  const lines = text.split("\n");
  const meta =
    lines.length > 1 && ROUND_HEADER.test(lines[0]!)
      ? lines.shift()!.split("|").map((part) => part.trim()).filter(Boolean)
      : [];
  const body = lines.join("\n").trim();
  const cut = body.lastIndexOf("\n");
  if (cut < 0) return { meta, context: "", ask: body };
  const last = body.slice(cut + 1);
  // A prompt that ends on a list item has no closing ask to lift out.
  if (LIST_ITEM.test(last)) return { meta, context: body, ask: "" };
  return { meta, context: body.slice(0, cut).trimEnd(), ask: last };
}
