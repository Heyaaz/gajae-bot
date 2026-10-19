import type { TranscriptItem } from "./backend/types";

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
  | { kind: "loaded"; items: TranscriptItem[]; revision: string | undefined };

/**
 * Safety-net read of one selected transcript.
 *
 * A known revision that is still current skips the body. Otherwise the body is
 * read between two revision samples, and the revision is returned only when
 * those samples match.
 */
export async function readTranscriptForSafetyNet(options: {
  knownRevision: string | undefined;
  readRevision?: () => Promise<string | undefined>;
  readItems: () => Promise<TranscriptItem[]>;
}): Promise<TranscriptSafetyRead> {
  const before = await probeRevision(options.readRevision);
  if (before && before === options.knownRevision) return { kind: "skipped" };
  const items = await options.readItems();
  const after = await probeRevision(options.readRevision);
  return {
    kind: "loaded",
    items,
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
