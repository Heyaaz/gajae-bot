import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Transcript } from "./transcript";

const noop = () => undefined;

describe("empty conversation state", () => {
  it("shows the plain prompt with no meta block when none is given", () => {
    const markup = renderToStaticMarkup(
      createElement(Transcript, {
        sessionId: "session-1",
        items: [],
        onResolveTool: noop,
      }),
    );
    expect(markup).toContain("Gajae에게 어떤 작업을 맡길까요?");
    expect(markup).not.toContain("empty-conversation__meta");
  });

  it("shows workspace, model, shortcut hints, and other-workspace shortcuts", () => {
    const markup = renderToStaticMarkup(
      createElement(Transcript, {
        sessionId: "session-1",
        items: [],
        onResolveTool: noop,
        emptyStateMeta: {
          workspace: "/Users/dev/gajae-bot",
          modelDisplay: "GJC default",
          recentWorkspaces: ["/Users/dev/gajae-bot", "/Users/dev/other-repo"],
          onWorkspaceChange: vi.fn(),
        },
      }),
    );
    expect(markup).toContain("empty-conversation__meta");
    expect(markup).toContain("gajae-bot");
    expect(markup).toContain("GJC default");
    expect(markup).toContain("other-repo");
    expect(markup).toContain("⌘K");
    expect(markup).toContain("⌘F");
  });

  it("omits the other-workspace shortcuts when there is only the current one", () => {
    const markup = renderToStaticMarkup(
      createElement(Transcript, {
        sessionId: "session-1",
        items: [],
        onResolveTool: noop,
        emptyStateMeta: {
          workspace: "/Users/dev/gajae-bot",
          recentWorkspaces: ["/Users/dev/gajae-bot"],
        },
      }),
    );
    expect(markup).not.toContain("empty-conversation__workspaces");
  });
});
