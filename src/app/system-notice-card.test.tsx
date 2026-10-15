import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SystemNoticeActivity } from "../../shared/agent-contract";
import { TranscriptItemView } from "./transcript";

/**
 * Injected runtime activity as the transcript renders it.
 *
 * These rows are the CLI's own channel traffic (IRC, hidden custom messages) and the
 * notices a compaction or an update writes. The reader asked for one dim line per
 * channel message instead of a card each, so the collapsed rendering is asserted here:
 * what is on screen, what stays one click away, and the labels that must not come back.
 */
function noticeItem(
  overrides: Partial<SystemNoticeActivity>,
): SystemNoticeActivity {
  return {
    id: "irc-incoming-1",
    kind: "system",
    sessionId: "session-1",
    title: "irc:incoming",
    content: "",
    createdAt: "now",
    ...overrides,
  };
}

function render(item: SystemNoticeActivity): string {
  return renderToStaticMarkup(
    createElement(TranscriptItemView, {
      item,
      onResolveTool: () => undefined,
      onReadArtifact: undefined,
    }),
  );
}

describe("runtime activity rows", () => {
  it("renders a hidden channel message as one line with the text on demand", () => {
    const payload = [
      "[IRC 16-TodoCardUI → you]",
      "TodoCardUI: my target list is shared/agent-contract.ts, src/app/transcript.tsx",
      "A real checklist needs a few lines of CSS.",
    ].join("\n");
    const markup = render(
      noticeItem({
        content: payload,
        sourceType: "irc:incoming",
        runtimeHidden: true,
      }),
    );

    expect(markup).toContain("system-card--runtime");
    expect(markup).toContain("irc:incoming");
    // The message itself identifies the row; the channel prefix is not repeated on
    // screen, and the label the reader struck out is gone from every path.
    expect(markup).not.toContain("런타임 활동");
    expect(markup).toContain("[IRC 16-TodoCardUI → you]");
    expect(markup).toContain('title="[IRC 16-TodoCardUI → you]');
    // Collapsed: only the first line is laid out (the rest is behind the title
    // attribute and the toggle), and one click opens the full message.
    const collapsed = /class="runtime-row-text"[^>]*>([^<]*)</u.exec(markup);
    expect(collapsed?.[1]).toBe("[IRC 16-TodoCardUI → you]");
    expect(markup).toContain("더 보기");
  });

  it("keeps a notice that is not channel traffic as a titled card without the label", () => {
    const markup = render(
      noticeItem({
        title: "Compaction",
        content: ["압축 완료", "둘", "셋", "넷"].join("\n"),
        sourceType: "compaction",
      }),
    );

    expect(markup).toContain("system-card");
    expect(markup).not.toContain("system-card--runtime");
    expect(markup).toContain("Compaction");
    expect(markup).not.toContain("런타임 활동");
    // The provenance is still named, just without the runtime-activity headline.
    expect(markup).toContain("compaction");
    expect(markup).toContain("더 보기");
  });
});
