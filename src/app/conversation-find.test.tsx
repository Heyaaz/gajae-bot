import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../backend/types";
import { ConversationFindBar, RecentRequestStrip } from "./transcript";

const userMessage = (id: string, content: string): TranscriptItem => ({
  id,
  sessionId: "session-1",
  kind: "message",
  role: "user",
  content,
  createdAt: "now",
});

describe("ConversationFindBar", () => {
  it("renders an empty match count before anything is typed", () => {
    const markup = renderToStaticMarkup(
      createElement(ConversationFindBar, {
        items: [userMessage("m1", "hello world")],
        onClose: vi.fn(),
        onReveal: vi.fn(),
      }),
    );
    expect(markup).toContain("conversation-find-count");
    expect(markup).toContain("이 대화에서 찾기");
  });

  it("disables the prev/next controls while nothing has matched", () => {
    const markup = renderToStaticMarkup(
      createElement(ConversationFindBar, {
        items: [userMessage("m1", "hello world")],
        onClose: vi.fn(),
        onReveal: vi.fn(),
      }),
    );
    expect(markup).toContain("disabled=\"\"");
  });
});

describe("RecentRequestStrip prompt timeline", () => {
  it("does not offer a timeline toggle when every request already fits the chip strip", () => {
    const markup = renderToStaticMarkup(
      createElement(RecentRequestStrip, {
        items: [userMessage("m1", "only one request")],
        onReveal: vi.fn(),
      }),
    );
    expect(markup).not.toContain("recent-requests-timeline-toggle");
  });

  it("offers a timeline toggle once there are more requests than the chip strip shows", () => {
    const items = Array.from({ length: 5 }, (_value, index) =>
      userMessage(`m${index}`, `request number ${index}`),
    );
    const markup = renderToStaticMarkup(
      createElement(RecentRequestStrip, { items, onReveal: vi.fn() }),
    );
    expect(markup).toContain("recent-requests-timeline-toggle");
    expect(markup).toContain("타임라인 (5)");
    // Closed by default: the popover itself is not in the initial markup.
    expect(markup).not.toContain("prompt-timeline");
  });

  it("keeps unloaded historical requests in the full timeline", () => {
    const markup = renderToStaticMarkup(
      createElement(RecentRequestStrip, {
        items: [userMessage("loaded", "recent request")],
        requestSummaries: [
          { id: "old", text: "request outside the loaded page", createdAt: "earlier" },
          { id: "loaded", text: "recent request", createdAt: "now" },
        ],
        onReveal: vi.fn(),
      }),
    );
    expect(markup).toContain("타임라인 (2)");
    // The chip strip stays bounded to loaded rows; the timeline count comes from the
    // all-history summary index rather than that shorter list.
    expect(markup).not.toContain("request outside the loaded page");
  });
});
