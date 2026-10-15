import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ThoughtActivity } from "../../shared/agent-contract";
import { TranscriptItemView } from "./transcript";

/**
 * The reasoning card reads one window-wide preference.
 *
 * The card used to own its open flag, so it started collapsed, forgot the choice when
 * the row was replaced, and a second card had to be opened again. These cases pin the
 * preference down: the prop decides, and the card has no state to shadow it with.
 */
function thoughtItem(overrides: Partial<ThoughtActivity>): ThoughtActivity {
  return {
    id: "gjc-thought-1",
    kind: "thought",
    sessionId: "session-1",
    content: "먼저 실패하는 테스트를 확인합니다",
    createdAt: "now",
    streaming: false,
    ...overrides,
  };
}

function render(item: ThoughtActivity, thoughtsExpanded: boolean): string {
  return renderToStaticMarkup(
    createElement(TranscriptItemView, {
      item,
      thoughtsExpanded,
      onToggleThoughtsExpanded: () => undefined,
      onResolveTool: () => undefined,
      onReadArtifact: undefined,
    }),
  );
}

describe("thought card", () => {
  it("renders the reasoning content while the preference is expanded", () => {
    const markup = render(thoughtItem({}), true);

    expect(markup).toContain("thought-card");
    expect(markup).toContain("thought-content");
    expect(markup).toContain("먼저 실패하는 테스트를 확인합니다");
    // The toggle keeps its label pair and offers the way back out.
    expect(markup).toContain("접기");
    expect(markup).not.toContain("펼치기");
  });

  it("renders only the header, and the way to open it, while collapsed", () => {
    const markup = render(thoughtItem({}), false);

    expect(markup).toContain("thought-card");
    expect(markup).toContain("Gajae");
    expect(markup).toContain("추론");
    expect(markup).toContain("펼치기");
    expect(markup).not.toContain("thought-content");
    expect(markup).not.toContain("먼저 실패하는 테스트를 확인합니다");
  });

  it("keeps streaming readable as thinking without opening the content for it", () => {
    const markup = render(
      thoughtItem({ streaming: true, content: "지금 확인 중입니다" }),
      false,
    );

    expect(markup).toContain("is-streaming");
    expect(markup).toContain("생각 중…");
    expect(markup).toContain("mini-spinner");
    expect(markup).not.toContain("thought-content");
    expect(markup).not.toContain("지금 확인 중입니다");
  });

  it("shows a streaming card's content once the preference is expanded", () => {
    const markup = render(
      thoughtItem({ streaming: true, content: "지금 확인 중입니다" }),
      true,
    );

    expect(markup).toContain("생각 중…");
    expect(markup).toContain("mini-spinner");
    expect(markup).toContain("thought-content is-streaming");
    expect(markup).toContain("지금 확인 중입니다");
  });

  it("keeps no local state that could shadow the preference", () => {
    // A card-owned flag cannot be seen in static markup -- it only shows up as the
    // second render disagreeing with the first, and every case here renders once. The
    // source is checked instead so the state cannot come back unnoticed, and because
    // the button is the only other place the flag could hide.
    const source = readFileSync(
      path.resolve(import.meta.dirname, "transcript.tsx"),
      "utf8",
    );
    const card = source.slice(
      source.indexOf("export function ThoughtCard({"),
      source.indexOf("export const TranscriptItemView"),
    );

    expect(card).toBeTruthy();
    expect(card).not.toContain("useState");
    expect(card).toContain("expanded: boolean");
    expect(card).toContain("onClick={onToggle}");
    expect(card).toContain("{expanded && (");
  });

  it("threads the preference and the toggle down to the card", () => {
    // The memo'd row is what makes a global toggle reach every card, so both props have
    // to be part of its input rather than a value read from somewhere else.
    const source = readFileSync(
      path.resolve(import.meta.dirname, "transcript.tsx"),
      "utf8",
    );
    const view = source.slice(
      source.indexOf("export const TranscriptItemView"),
      source.indexOf("export interface ToolCardProps"),
    );

    expect(view).toContain("thoughtsExpanded = false");
    expect(view).toContain("onToggleThoughtsExpanded");
    expect(view).toContain("expanded={thoughtsExpanded}");
    expect(view).toContain("onToggle={onToggleThoughtsExpanded}");
  });
});
