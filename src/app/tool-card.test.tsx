import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../backend/types";
import { TranscriptItemView } from "./transcript";

const tool = (status: string): TranscriptItem =>
  ({
    id: "call-1",
    sessionId: "session-1",
    kind: "tool",
    name: "bash",
    description: "bash",
    status,
    createdAt: "now",
  }) as unknown as TranscriptItem;

const noop = () => undefined;

function render(status: string): string {
  return renderToStaticMarkup(
    createElement(TranscriptItemView, {
      item: tool(status),
      onResolveTool: noop,
      onReadArtifact: noop,
      onPreviewFile: noop,
    } as never),
  );
}

describe("tool card status", () => {
  it("shows a queued call as waiting, with no spinner", () => {
    // Captured live from gjc/0.15.3: a tool call arrives `pending` and only reports
    // `in_progress` seconds later (7s in the run that was measured). Both used to
    // render as 작업 중 with a spinner, so a call that had not started looked like
    // work underway -- the spinner is the part that makes that claim.
    const markup = render("pending");
    expect(markup).toContain("대기 중");
    expect(markup).not.toContain("작업 중");
    expect(markup).not.toContain("mini-spinner");
  });

  it("shows an executing call as working, with a spinner", () => {
    const markup = render("running");
    expect(markup).toContain("작업 중");
    expect(markup).toContain("mini-spinner");
  });

  it("shows a finished call as complete", () => {
    const markup = render("completed");
    expect(markup).toContain("완료");
    expect(markup).not.toContain("mini-spinner");
  });
});
