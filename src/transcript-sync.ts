import type { TranscriptChange, TranscriptItem } from "./backend/types";

/**
 * Revision that is safe to remember for a body just read.
 *
 * The sample taken before the read and the sample taken after it have to be the
 * same. A revision observed only after the read can belong to a write the body
 * missed, and the next poll would treat that newer revision as current and skip
 * the change forever.
 */
export function stableTranscriptRevision(
  before: string | undefined,
  after: string | undefined,
): string | undefined {
  if (!before || before !== after) return undefined;
  return before;
}

export type TranscriptSafetyRead =
  | { kind: "skipped" }
  | {
      kind: "loaded";
      items: TranscriptItem[];
      change: TranscriptChange;
      revision: string | undefined;
    };

function asTranscriptChange(
  loaded: TranscriptItem[] | TranscriptChange,
): TranscriptChange {
  return Array.isArray(loaded) ? { kind: "full", items: loaded } : loaded;
}

/**
 * Safety-net read of one selected transcript.
 *
 * A known revision that is still current skips the body. Otherwise the body is
 * read between two revision samples, and the revision is returned only when
 * those samples match. A backend may return a patch of changed rows instead of
 * the whole conversation.
 */
export async function readTranscriptForSafetyNet(options: {
  knownRevision: string | undefined;
  readRevision?: () => Promise<string | undefined>;
  readItems: () => Promise<TranscriptItem[] | TranscriptChange>;
}): Promise<TranscriptSafetyRead> {
  const before = await probeRevision(options.readRevision);
  if (before && before === options.knownRevision) return { kind: "skipped" };
  const change = asTranscriptChange(await options.readItems());
  const after = await probeRevision(options.readRevision);
  return {
    kind: "loaded",
    items: change.kind === "full" ? change.items : change.items,
    change,
    revision: stableTranscriptRevision(before, after),
  };
}

async function probeRevision(
  read: (() => Promise<string | undefined>) | undefined,
): Promise<string | undefined> {
  if (!read) return undefined;
  try {
    return await read();
  } catch {
    return undefined;
  }
}
