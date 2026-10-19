import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../backend/types";
import { TranscriptItemView } from "./transcript";

const noop = () => undefined;

function assistantMessage(content: string): TranscriptItem {
  return {
    id: "msg-1",
    sessionId: "session-1",
    kind: "message",
    role: "assistant",
    content,
    createdAt: "now",
  };
}

function render(content: string): string {
  return renderToStaticMarkup(
    createElement(TranscriptItemView, {
      item: assistantMessage(content),
      onResolveTool: noop,
      onReadArtifact: noop,
    } as never),
  );
}

describe("fenced code block rendering", () => {
  it("shows the fence's language and a copy control", () => {
    const markup = render("```ts\nconst x = 1;\n```");
    expect(markup).toContain("code-block-lang");
    expect(markup).toContain(">ts<");
    expect(markup).toContain("code-block-copy");
  });

  it("falls back to a plain pre for a fence with no language", () => {
    const markup = render("```\nplain text\n```");
    expect(markup).not.toContain("code-block-lang");
    expect(markup).toContain("plain text");
  });

  it("leaves inline code untouched", () => {
    const markup = render("some `inline code` here");
    expect(markup).not.toContain("code-block");
    expect(markup).toContain("inline code");
  });
});
