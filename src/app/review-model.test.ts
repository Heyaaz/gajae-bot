import { describe, expect, it, vi } from "vitest";
import {
  formatReview,
  parseDiffPatch,
  reviewAnchor,
  reviewComments,
  saveReviewComments,
  subscribeReviewComments,
  type ReviewComment,
} from "./review-model";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,4 +10,3 @@ function a() {",
  " const keep = 1;",
  "-const before = 2;",
  "-const gone = 3;",
  "+const after = 2;",
  " return keep;",
  "@@ -40,2 +40,3 @@",
  " tail();",
  "+added();",
  " end();",
  "",
].join("\n");

function comment(overrides: Partial<ReviewComment>): ReviewComment {
  return {
    id: "c",
    file: "src/a.ts",
    startLine: 1,
    endLine: 1,
    side: "new",
    excerpt: "+x",
    body: "body",
    ...overrides,
  };
}

describe("parseDiffPatch", () => {
  it("numbers context, removed and added rows on their own side", () => {
    const rows = parseDiffPatch(PATCH);
    expect(rows.map((row) => row.kind)).toEqual([
      "meta", "meta", "meta",
      "hunk", "context", "del", "del", "add", "context",
      "hunk", "context", "add", "context",
    ]);
    expect(rows[4]).toMatchObject({ oldLine: 10, newLine: 10 });
    expect(rows[6]).toMatchObject({ kind: "del", oldLine: 12 });
    expect(rows[7]).toMatchObject({ kind: "add", newLine: 11 });
    expect(rows[8]).toMatchObject({ oldLine: 13, newLine: 12 });
    expect(rows[11]).toMatchObject({ kind: "add", newLine: 41 });
  });

  it("does not read the next file's --- and +++ headers as changed lines", () => {
    const rows = parseDiffPatch([
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- a/next.ts",
      "+++ b/next.ts",
      "@@ -5 +5,2 @@",
      " five",
      "+six",
    ].join("\n"));
    expect(rows.map((row) => row.kind)).toEqual([
      "hunk", "del", "add", "meta", "meta", "hunk", "context", "add",
    ]);
  });

  it("leaves a body without hunk headers uncommentable", () => {
    expect(parseDiffPatch("Binary files differ").map((row) => row.kind)).toEqual(["meta"]);
  });
});

describe("reviewAnchor", () => {
  const rows = parseDiffPatch(PATCH);

  it("anchors a mixed range on the new file and keeps every row in the excerpt", () => {
    expect(reviewAnchor("src/a.ts", rows, 8, 4)).toEqual({
      file: "src/a.ts",
      side: "new",
      startLine: 10,
      endLine: 12,
      excerpt: " const keep = 1;\n-const before = 2;\n-const gone = 3;\n+const after = 2;\n return keep;",
    });
  });

  it("anchors a range of removed rows on the old file", () => {
    expect(reviewAnchor("src/a.ts", rows, 5, 6)).toMatchObject({
      side: "old",
      startLine: 11,
      endLine: 12,
    });
  });

  it("refuses a range that crosses hunks or starts on a header", () => {
    expect(reviewAnchor("src/a.ts", rows, 4, 11)).toBeNull();
    expect(reviewAnchor("src/a.ts", rows, 3, 4)).toBeNull();
  });
});

describe("formatReview", () => {
  it("renders file:line, the code excerpt and the comment for each entry in order", () => {
    const text = formatReview([
      comment({ startLine: 10, endLine: 12, excerpt: " a\n+b", body: "  rename this  " }),
      comment({ file: "src/b.ts", startLine: 3, endLine: 3, side: "old", excerpt: "-c", body: "keep it" }),
    ]);
    expect(text).toBe([
      "다음 코드 리뷰 코멘트를 반영해 주세요.",
      "",
      "1. src/a.ts:10-12",
      "```diff",
      " a",
      "+b",
      "```",
      "rename this",
      "",
      "2. src/b.ts:3 (변경 전)",
      "```diff",
      "-c",
      "```",
      "keep it",
    ].join("\n"));
  });

  it("fences an excerpt that itself contains a code fence", () => {
    const text = formatReview([comment({ excerpt: "+```ts" })]);
    expect(text).toContain("````diff\n+```ts\n````");
  });
});

describe("review drafts", () => {
  it("keeps each session's comments and notifies only that session", () => {
    const a = vi.fn();
    const b = vi.fn();
    const stopA = subscribeReviewComments("review-a", a);
    const stopB = subscribeReviewComments("review-b", b);
    saveReviewComments("review-a", [comment({ id: "1" })]);
    expect(reviewComments("review-a").map((entry) => entry.id)).toEqual(["1"]);
    expect(reviewComments("review-b")).toEqual([]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    saveReviewComments("review-a", []);
    expect(reviewComments("review-a")).toEqual([]);
    stopA();
    stopB();
  });
});
