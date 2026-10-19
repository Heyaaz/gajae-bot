import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GajaeProgressRow } from "./gajae-progress";
import { formatWorkedSummary, gajaeEmoticonFor } from "../transcript-utils";

function render(props: Parameters<typeof GajaeProgressRow>[0]): string {
  return renderToStaticMarkup(createElement(GajaeProgressRow, props));
}

const clock = {
  ticking: false,
  startedAt: 1_000,
  pausedMs: 0,
  heldAt: 73_000,
};

describe("GajaeProgressRow", () => {
  it("shows a rotating working phrase, the coding gajae, and the Esc hint", () => {
    const markup = render({
      kind: "thinking",
      ticking: true,
      startedAt: 1_000,
      pausedMs: 0,
    });
    expect(markup).toContain('data-kind="thinking"');
    expect(markup).toContain(`data-emoticon="${gajaeEmoticonFor("thinking")}"`);
    expect(markup).toContain("생각 중…");
    expect(markup).toContain("Esc");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("응답 대기 중");
  });

  it("holds a sleepy gajae on the input phrase and does not offer Esc", () => {
    const markup = render({
      kind: "waiting",
      label: "입력을 기다리고 있어요",
      ...clock,
    });
    expect(markup).toContain('data-emoticon="sleepy"');
    expect(markup).toContain("입력을 기다리고 있어요");
    expect(markup).toContain("Ⅱ 1:12");
    expect(markup).not.toContain("Esc");
  });

  it("offers allow and deny on the surprised gajae without the banner's wording", () => {
    const markup = render({
      kind: "approval",
      label: "승인이 필요해요",
      ...clock,
      approval: {
        toolId: "tool-1",
        deny: { optionId: "no", name: "Reject" },
        allow: { optionId: "yes", name: "Allow" },
      },
    });
    expect(markup).toContain('data-emoticon="surprised"');
    expect(markup).toContain("승인이 필요해요");
    expect(markup).toContain("거절");
    expect(markup).toContain("허용");
    expect(markup).not.toContain("승인 대기");
  });

  it("offers retry on the crying gajae", () => {
    const markup = render({
      kind: "error",
      label: "오류가 났어요",
      ...clock,
      onRetry: () => undefined,
    });
    expect(markup).toContain('data-emoticon="crying"');
    expect(markup).toContain("다시 시도");
    expect(markup).toContain("오류가 났어요");
  });

  it("keeps the worked summary in the done row", () => {
    const markup = render({ kind: "done", ...clock });
    expect(markup).toContain('data-emoticon="celebrate"');
    expect(markup).toContain(`${formatWorkedSummary(72_000)} ▸`);
    expect(markup).toContain("1분 12초 작업");
  });
});
