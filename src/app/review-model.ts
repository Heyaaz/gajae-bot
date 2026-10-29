import { t } from "../i18n";

/** Which version of the file a line number counts in: a removed line exists only in the old one. */
export type DiffSide = "old" | "new";

/** One row of a unified patch. `text` is the raw row, including its +/-/space prefix. */
export type DiffLine =
  | { kind: "meta"; text: string }
  | { kind: "hunk"; text: string; hunk: number }
  | { kind: "context"; text: string; hunk: number; oldLine: number; newLine: number }
  | { kind: "add"; text: string; hunk: number; newLine: number }
  | { kind: "del"; text: string; hunk: number; oldLine: number };

export type CommentableLine = Extract<DiffLine, { kind: "context" | "add" | "del" }>;

export interface ReviewComment {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  side: DiffSide;
  excerpt: string;
  body: string;
}

export type ReviewAnchor = Omit<ReviewComment, "id" | "body">;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/**
 * Number every row of a patch. A hunk's body is exactly as long as its header
 * says, so a `---`/`+++` header of a following file is never read as a removed
 * or added line.
 */
export function parseDiffPatch(patch: string): DiffLine[] {
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const lines: DiffLine[] = [];
  let hunk = -1;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const text of rows) {
    const header = oldLeft === 0 && newLeft === 0 ? HUNK_HEADER.exec(text) : null;
    if (header) {
      hunk += 1;
      oldLine = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLine = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      lines.push({ kind: "hunk", text, hunk });
    } else if (oldLeft === 0 && newLeft === 0) {
      lines.push({ kind: "meta", text });
    } else if (text.startsWith("+") && newLeft > 0) {
      lines.push({ kind: "add", text, hunk, newLine: newLine++ });
      newLeft -= 1;
    } else if (text.startsWith("-") && oldLeft > 0) {
      lines.push({ kind: "del", text, hunk, oldLine: oldLine++ });
      oldLeft -= 1;
    } else if (text.startsWith("\\")) {
      lines.push({ kind: "meta", text });
    } else {
      lines.push({ kind: "context", text, hunk, oldLine: oldLine++, newLine: newLine++ });
      oldLeft = Math.max(0, oldLeft - 1);
      newLeft = Math.max(0, newLeft - 1);
    }
  }
  return lines;
}

export function isCommentable(line: DiffLine): line is CommentableLine {
  return line.kind === "context" || line.kind === "add" || line.kind === "del";
}

/** A row's identity that survives a refresh of the same diff. */
export function diffLineKey(line: CommentableLine): string {
  return line.kind === "del" ? `o${line.oldLine}` : `n${line.newLine}`;
}

/** The row keys of a comment's first and last line. */
export function anchorLineKeys(
  anchor: Pick<ReviewAnchor, "side" | "startLine" | "endLine">,
): [string, string] {
  const prefix = anchor.side === "old" ? "o" : "n";
  return [`${prefix}${anchor.startLine}`, `${prefix}${anchor.endLine}`];
}

/** The line number a row shows: its old number only when it no longer exists. */
export function diffLineNumber(line: CommentableLine): number {
  return line.kind === "del" ? line.oldLine : line.newLine;
}

/**
 * The anchor for rows `from..to` (either order) of one file's parsed patch, or
 * null when they do not form one range inside a single hunk. A range counts in
 * the old file only when every row in it was removed.
 */
export function reviewAnchor(
  file: string,
  lines: readonly DiffLine[],
  from: number,
  to: number,
): ReviewAnchor | null {
  const first = lines[Math.min(from, to)];
  const last = lines[Math.max(from, to)];
  if (!first || !last || !isCommentable(first) || !isCommentable(last)) return null;
  if (first.hunk !== last.hunk) return null;
  const rows = lines
    .slice(Math.min(from, to), Math.max(from, to) + 1)
    .filter(isCommentable);
  const side: DiffSide = rows.every((row) => row.kind === "del") ? "old" : "new";
  const numbers = rows.flatMap((row) =>
    row.kind === "del" ? (side === "old" ? [row.oldLine] : []) : [row.newLine],
  );
  return {
    file,
    side,
    startLine: Math.min(...numbers),
    endLine: Math.max(...numbers),
    excerpt: rows.map((row) => row.text).join("\n"),
  };
}

/** `파일:줄` for one comment, as it appears in the panel and in the request. */
export function reviewLocation(comment: ReviewAnchor): string {
  const lines = comment.startLine === comment.endLine
    ? `${comment.startLine}`
    : `${comment.startLine}-${comment.endLine}`;
  const place = `${comment.file}:${lines}`;
  return comment.side === "old" ? t`${place} (변경 전)` : place;
}

function fence(excerpt: string): string {
  const longest = Math.max(0, ...[...excerpt.matchAll(/`+/gu)].map((run) => run[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** One request that carries every comment: where, the code it points at, and what to change. */
export function formatReview(comments: readonly ReviewComment[]): string {
  const items = comments.map((comment, index) => {
    const marks = fence(comment.excerpt);
    return [
      `${index + 1}. ${reviewLocation(comment)}`,
      `${marks}diff`,
      comment.excerpt,
      marks,
      comment.body.trim(),
    ].join("\n");
  });
  return [t("다음 코드 리뷰 코멘트를 반영해 주세요."), ...items].join("\n\n");
}

// Draft comments belong to a session and outlive the panel that made them, so
// closing the diff or switching to the repository screen keeps them. They stay
// in memory only: after a reload the agent may have rewritten the lines they
// point at, and a stale `파일:줄` would send it to the wrong code.
const EMPTY: readonly ReviewComment[] = [];
const drafts = new Map<string, readonly ReviewComment[]>();
const listeners = new Map<string, Set<() => void>>();

export function reviewComments(sessionId: string): readonly ReviewComment[] {
  return drafts.get(sessionId) ?? EMPTY;
}

export function saveReviewComments(
  sessionId: string,
  comments: readonly ReviewComment[],
): void {
  if (comments.length > 0) drafts.set(sessionId, comments);
  else drafts.delete(sessionId);
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

export function subscribeReviewComments(
  sessionId: string,
  listener: () => void,
): () => void {
  const set = listeners.get(sessionId) ?? new Set();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(sessionId);
  };
}
