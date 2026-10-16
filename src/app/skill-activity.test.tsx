import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../backend/types";
import { parseSkillInvocation } from "../transcript-utils";
import { TranscriptItemView } from "./transcript";

function render(item: TranscriptItem): string {
  return renderToStaticMarkup(createElement(TranscriptItemView, {
    item,
    onResolveTool: () => undefined,
    onReadArtifact: undefined,
  }));
}

function prompt(content: string, title = "스킬"): TranscriptItem {
  return { id: "skill-prompt-1", kind: "system", sessionId: "session-1", sourceType: "skill-prompt", title, content, createdAt: "01:44" };
}

function message(content: string, role: "user" | "assistant" = "user"): TranscriptItem {
  return { id: "skill-command-1", kind: "message", sessionId: "session-1", role, content, createdAt: "01:41" };
}

describe("skill transcript presentation", () => {
  it("parses skill invocations without losing multiline arguments", () => {
    expect(parseSkillInvocation("/skill:whip")).toEqual({ name: "whip", args: "" });
    expect(parseSkillInvocation("/skill:review-ui inspect this\nand preserve attachments")).toEqual({ name: "review-ui", args: "inspect this\nand preserve attachments" });
  });

  it.each(["/skill", "/skill:", "/skill:../private", "Use /skill:whip here", "/skill:foo/bar", "/skill:foo\\bar", "# Whip"])("does not relabel ordinary or invalid text: %s", (content) => {
    expect(parseSkillInvocation(content)).toBeUndefined();
  });

  it("renders a user invocation with its skill identity and keeps its copy action", () => {
    const markup = render(message("/skill:whip audit the UI"));
    expect(markup).toContain("message--skill");
    expect(markup).toContain('aria-label="스킬 호출: whip"');
    expect(markup).toContain("<strong>whip</strong>");
    expect(markup).toContain("audit the UI");
    expect(markup).toContain("message-copy");
    expect(markup).toContain("01:41");
  });

  it("does not style an assistant mentioning a command as a user invocation", () => {
    const markup = render(message("/skill:whip", "assistant"));
    expect(markup).not.toContain("message--skill");
    expect(markup).toContain("/skill:whip");
  });

  it("renders skill instructions collapsed without mounting a giant markdown preview", () => {
    const markup = render(prompt("# Whip\n\nVerify the result.\n\n## Rules\nDo not discard the original instructions."));
    expect(markup).toContain('<details class="skill-activity">');
    expect(markup).toContain("<summary");
    expect(markup).toContain('title="Whip"');
    expect(markup).toContain("스킬 지침");
    expect(markup).toContain("원문 보기");
    expect(markup).not.toContain("Verify the result.");
    expect(markup).not.toContain("skill-prompt");
    expect(markup).not.toContain("system-card");
    expect(markup).not.toContain("완료");
  });

  it("keeps a meaningful title when instructions contain no heading", () => {
    expect(render(prompt("Plain text instructions", "code-review"))).toContain('title="code-review"');
    expect(render(prompt("Plain text instructions"))).toContain('title="스킬 지침"');
  });

  it("retains normal system cards for non-skill notices", () => {
    const item = { ...prompt("Runtime was reloaded", "Runtime"), sourceType: "runtime.reload" } as TranscriptItem;
    const markup = render(item);
    expect(markup).toContain("system-card");
    expect(markup).not.toContain("skill-activity");
    expect(markup).toContain("Runtime was reloaded");
  });
});
