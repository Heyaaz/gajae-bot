import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../backend/types";
import { TranscriptItemView } from "./transcript";

const noop = () => undefined;

function noticeItem(id: string, title: string): TranscriptItem {
  return {
    id,
    sessionId: "session-1",
    kind: "notice",
    title,
    content: "network timeout",
    tone: "warning",
    createdAt: "now",
  };
}

function render(item: TranscriptItem, onRetryLastRequest?: (sessionId: string) => void): string {
  return renderToStaticMarkup(
    createElement(TranscriptItemView, {
      item,
      onResolveTool: noop,
      onReadArtifact: noop,
      onRetryLastRequest,
    } as never),
  );
}

describe("run-failure notice retry button", () => {
  it("shows a retry button for a gjc-error- run-failure notice when a handler is given", () => {
    const markup = render(noticeItem("gjc-error-1", "GJC run failed"), vi.fn());
    expect(markup).toContain("notice-card-retry");
    expect(markup).toContain("다시 시도");
  });

  it("omits the retry button when no handler is given", () => {
    const markup = render(noticeItem("gjc-error-1", "GJC run failed"), undefined);
    expect(markup).not.toContain("notice-card-retry");
  });

  it("omits the retry button on a notice that is not a run failure (e.g. cancelled)", () => {
    const markup = render(noticeItem("gjc-cancelled-1", "작업 취소됨"), vi.fn());
    expect(markup).not.toContain("notice-card-retry");
  });
});
