import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../backend/types";
import { ApprovalBanner } from "./transcript";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

const approvalTool = (id: string, name = "bash"): ToolItem => ({
  id,
  sessionId: "session-1",
  kind: "tool",
  name,
  description: name,
  status: "approval-required",
  createdAt: "now",
});

const noop = () => undefined;

describe("ApprovalBanner", () => {
  it("renders nothing when no approval is pending", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalBanner, {
        pending: [],
        onReveal: noop,
        onFocusChange: noop,
      }),
    );
    expect(markup).toBe("");
  });

  it("names the count and the focused tool when one is pending", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalBanner, {
        pending: [approvalTool("a", "bash")],
        onReveal: noop,
        onFocusChange: noop,
      }),
    );
    expect(markup).toContain("승인 대기 1건");
    expect(markup).not.toContain("다음 대기");
  });

  it("offers a next-pending control only when more than one is waiting", () => {
    const pending = [approvalTool("a"), approvalTool("b")];
    const markup = renderToStaticMarkup(
      createElement(ApprovalBanner, {
        pending,
        onReveal: noop,
        onFocusChange: noop,
      }),
    );
    expect(markup).toContain("승인 대기 2건");
    expect(markup).toContain("다음 대기");
  });

  it("follows the focusedId prop rather than always the first pending call", () => {
    const pending = [approvalTool("a", "bash"), approvalTool("b", "edit")];
    const markup = renderToStaticMarkup(
      createElement(ApprovalBanner, {
        pending,
        focusedId: "b",
        onReveal: noop,
        onFocusChange: noop,
      }),
    );
    expect(markup).toContain("Edit");
  });
});
