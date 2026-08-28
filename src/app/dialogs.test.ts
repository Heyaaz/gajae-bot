import { describe, expect, it } from "vitest";
import { sessionSummaryLine, workspaceLabelFor } from "./dialogs";

describe("sessionSummaryLine", () => {
  it("keeps a short title exactly as it is", () => {
    expect(sessionSummaryLine("라우터 5초 고치기")).toBe("라우터 5초 고치기");
  });

  it("cuts a long first request down to one readable line", () => {
    // A session title is the whole first request, which runs to hundreds of
    // characters. Left alone it widened the row and pushed the id/time line out
    // of the dialog.
    const long =
      "운영 서버 이전을 해야하거든 ? [신규 클라우드 서버] CPU : 8vcore RAM : 16G SSD : 200G IP ADDRESS : 1.2.3.4 이런 스펙으로 옮기려고 하는데 어떤 순서로 진행하면 좋을지 알려줘";
    const summary = sessionSummaryLine(long);
    expect(summary.length).toBeLessThanOrEqual(72);
    expect(summary.endsWith("…")).toBe(true);
    expect(long.startsWith(summary.slice(0, -1).trimEnd())).toBe(true);
  });

  it("collapses the newlines a multi-line request carries", () => {
    expect(sessionSummaryLine("첫 줄\n\n둘째  줄")).toBe("첫 줄 둘째 줄");
  });
});

describe("workspaceLabelFor", () => {
  it("shortens a deep path to its project folder", () => {
    expect(workspaceLabelFor("/Users/byeonheejae/pro/agent-control")).toBe(
      "…/pro/agent-control",
    );
  });

  it("leaves a shallow path whole", () => {
    expect(workspaceLabelFor("/tmp")).toBe("/tmp");
  });

  it("reports nothing for a session with no recorded folder", () => {
    expect(workspaceLabelFor("")).toBe("");
  });
});
