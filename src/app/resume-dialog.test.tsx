import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HistorySession } from "../../shared/agent-contract";
import { ResumeSessionDialog } from "./dialogs";

/**
 * The picker is a recency list, so lineage is marked in place rather than reordering
 * rows under a source that may sit far down the list.
 */
function history(overrides: Partial<HistorySession>): HistorySession {
  return {
    id: "session",
    title: "Session",
    workspace: "/tmp/project",
    updatedAt: "now",
    messageCount: 3,
    live: false,
    ...overrides,
  };
}

function render(sessions: HistorySession[]): string {
  return renderToStaticMarkup(
    createElement(ResumeSessionDialog, {
      sessions,
      loading: false,
      error: "",
      busyId: null,
      onClose: () => undefined,
      onOpen: () => undefined,
    }),
  );
}

describe("ResumeSessionDialog lineage", () => {
  it("marks a fork and names its source when the list has it", () => {
    const markup = render([
      history({ id: "source123456", title: "원본 세션" }),
      history({ id: "fork123456789", title: "포크된 세션", parentId: "source123456" }),
    ]);
    expect(markup).toContain('class="resume-fork"');
    expect(markup).toContain("원본 세션에서 포크");
  });

  it("marks a fork whose source is outside the list by id", () => {
    const markup = render([
      history({ id: "fork123456789", title: "포크된 세션", parentId: "older-source" }),
    ]);
    expect(markup).toContain("포크: older-source");
  });

  it("leaves a session with no recorded source unmarked", () => {
    const markup = render([history({ id: "root123456789", title: "그냥 세션" })]);
    expect(markup).not.toContain("resume-fork");
  });
});
