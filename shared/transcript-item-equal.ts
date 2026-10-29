import type { TranscriptChange, TranscriptItem } from "./agent-contract.js";

function sameList<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
  same: (leftItem: T, rightItem: T) => boolean,
): boolean {
  if (left === right) return true;
  const leftLength = left?.length ?? 0;
  const rightLength = right?.length ?? 0;
  if (leftLength !== rightLength) return false;
  if (leftLength === 0) return true;
  return left!.every((item, index) => same(item, right![index]!));
}

/**
 * Whether two transcript rows are the same record.
 *
 * A safety-net read rebuilds every row. Comparing the fields that the view
 * reads avoids serialising the whole row, which on a long session repeated the
 * conversation once per unchanged line.
 */
export function transcriptItemEqual(
  left: TranscriptItem,
  right: TranscriptItem,
): boolean {
  if (left === right) return true;
  if (left.kind !== right.kind || left.id !== right.id || left.sessionId !== right.sessionId)
    return false;
  switch (left.kind) {
    case "message":
      return (
        right.kind === "message" &&
        left.role === right.role &&
        left.content === right.content &&
        left.createdAt === right.createdAt &&
        left.streaming === right.streaming &&
        sameList(left.images, right.images, (image, other) =>
          image.id === other.id &&
          image.name === other.name &&
          image.mimeType === other.mimeType &&
          image.data === other.data,
        )
      );
    case "tool":
      return (
        right.kind === "tool" &&
        left.name === right.name &&
        left.description === right.description &&
        left.command === right.command &&
        left.status === right.status &&
        left.createdAt === right.createdAt &&
        left.output === right.output &&
        left.inputArtifactId === right.inputArtifactId &&
        left.outputArtifactId === right.outputArtifactId &&
        left.diff === right.diff &&
        left.targetPath === right.targetPath &&
        sameList(left.artifactRefs, right.artifactRefs, (ref, other) => ref === other) &&
        sameList(
          left.permissionOptions,
          right.permissionOptions,
          (option, other) =>
            option.optionId === other.optionId &&
            option.kind === other.kind &&
            option.name === other.name,
        ) &&
        sameList(
          left.images,
          right.images,
          (image, other) =>
            image.mimeType === other.mimeType &&
            image.dataUrl === other.dataUrl &&
            image.blobId === other.blobId,
        ) &&
        sameList(
          left.subagents,
          right.subagents,
          (agent, other) =>
            agent.id === other.id &&
            agent.label === other.label &&
            agent.status === other.status &&
            agent.role === other.role &&
            agent.objective === other.objective &&
            agent.detail === other.detail,
        )
      );
    case "notice":
      return (
        right.kind === "notice" &&
        left.title === right.title &&
        left.content === right.content &&
        left.tone === right.tone &&
        left.createdAt === right.createdAt
      );
    case "thought":
      return (
        right.kind === "thought" &&
        left.content === right.content &&
        left.createdAt === right.createdAt &&
        left.streaming === right.streaming
      );
    case "plan":
      return (
        right.kind === "plan" &&
        left.createdAt === right.createdAt &&
        sameList(
          left.entries,
          right.entries,
          (entry, other) => entry.content === other.content && entry.status === other.status,
        )
      );
    case "compaction":
      return (
        right.kind === "compaction" &&
        left.tokensBefore === right.tokensBefore &&
        left.summary === right.summary &&
        left.shortSummary === right.shortSummary &&
        left.createdAt === right.createdAt
      );
    case "branch_summary":
      return (
        right.kind === "branch_summary" &&
        left.summary === right.summary &&
        left.createdAt === right.createdAt
      );
    case "system":
      return (
        right.kind === "system" &&
        left.title === right.title &&
        left.content === right.content &&
        left.createdAt === right.createdAt &&
        left.sourceType === right.sourceType &&
        left.runtimeHidden === right.runtimeHidden &&
        left.observedAt === right.observedAt &&
        sameList(left.todoPhases, right.todoPhases, (phase, other) =>
          phase.name === other.name &&
          sameList(
            phase.tasks,
            other.tasks,
            (task, otherTask) =>
              task.content === otherTask.content &&
              task.status === otherTask.status &&
              sameList(task.notes, otherTask.notes, (note, otherNote) => note === otherNote),
          ),
        )
      );
    case "question":
      return (
        right.kind === "question" &&
        left.question === right.question &&
        left.multi === right.multi &&
        left.status === right.status &&
        left.createdAt === right.createdAt &&
        left.answerable === right.answerable &&
        left.tag === right.tag &&
        left.expectedSessionId === right.expectedSessionId &&
        left.approval === right.approval &&
        left.answerSummary === right.answerSummary &&
        left.error === right.error &&
        left.runtimeTurnId === right.runtimeTurnId &&
        sameList(
          left.options,
          right.options,
          (option, other) =>
            option.label === other.label && option.recommended === other.recommended,
        )
      );
    default: {
      const exhaustive: never = left;
      return exhaustive === right;
    }
  }
}

export function transcriptItemsEqual(
  left: readonly TranscriptItem[],
  right: readonly TranscriptItem[],
): boolean {
  return sameList(left, right, transcriptItemEqual);
}


/**
 * What a safety-net read should send across IPC.
 *
 * The first read, a shorter history, or a row that moved has to travel whole.
 * An append or an in-place edit sends only those rows. Comparing fields, not
 * `JSON.stringify` of the row, keeps a long tool output from being serialised
 * just to decide it did not change.
 */
export function transcriptDelivery(
  previous: readonly TranscriptItem[] | undefined,
  next: readonly TranscriptItem[],
): TranscriptChange {
  if (!previous || previous.length === 0) return { kind: "full", items: [...next] };
  if (previous.length > next.length) return { kind: "full", items: [...next] };
  const present = new Set(next.map((item) => item.id));
  if (previous.some((item) => !present.has(item.id)))
    return { kind: "full", items: [...next] };
  const changed: TranscriptItem[] = [];
  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index]!;
    const after = next[index]!;
    if (before.id !== after.id) return { kind: "full", items: [...next] };
    if (!transcriptItemEqual(before, after)) changed.push(after);
  }
  for (let index = previous.length; index < next.length; index += 1)
    changed.push(next[index]!);
  return { kind: "patch", items: changed };
}
