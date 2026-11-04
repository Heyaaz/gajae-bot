import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, afterEach } from "vitest";
import { GajaeProgressRow } from "./gajae-progress";
import { gajaeEmoticonFor } from "../transcript-utils";
import { setLanguageMode } from "../i18n";
import { LoginHintContext } from "./login-hint";

afterEach(() => setLanguageMode("ko"));

function render(props: Parameters<typeof GajaeProgressRow>[0]): string {
  return renderToStaticMarkup(createElement(GajaeProgressRow, props));
}

describe("GajaeProgressRow", () => {
  it("shows a rotating working phrase and the coding gajae without a clock or Esc hint", () => {
    const markup = render({
      kind: "thinking",
    });
    expect(markup).toContain('data-kind="thinking"');
    expect(markup).toContain(`data-emoticon="${gajaeEmoticonFor("thinking")}"`);
    expect(markup).toContain("생각 중…");
    expect(markup).not.toContain("Esc");
    expect(markup).not.toContain("gajae-progress-time");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("응답 대기 중");
  });

  it("renders the working phrase in English when English is selected", () => {
    setLanguageMode("en");
    const markup = render({ kind: "thinking" });
    expect(markup).toContain("Thinking…");
    expect(markup).not.toContain("생각 중");
  });

  it("holds a sleepy gajae on the input phrase and does not offer Esc", () => {
    const markup = render({
      kind: "waiting",
      label: "입력을 기다리고 있어요",
    });
    expect(markup).toContain('data-emoticon="sleepy"');
    expect(markup).toContain("입력을 기다리고 있어요");
    expect(markup).not.toContain("Esc");
    expect(markup).not.toContain("gajae-progress-time");
  });

  it("offers allow and deny on the surprised gajae without the banner's wording", () => {
    const markup = render({
      kind: "approval",
      label: "승인이 필요해요",
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
    expect(markup).not.toContain("gajae-progress-time");
  });

  it("offers retry on the crying gajae", () => {
    const markup = render({
      kind: "error",
      label: "오류가 났어요",
      onRetry: () => undefined,
    });
    expect(markup).toContain('data-emoticon="crying"');
    expect(markup).toContain("다시 시도");
    expect(markup).toContain("오류가 났어요");
  });

  it("keeps a plain completion summary without elapsed time", () => {
    const markup = render({ kind: "done" });
    expect(markup).toContain('data-emoticon="celebrate"');
    expect(markup).toContain("완료");
    expect(markup).not.toContain("초 작업");
    expect(markup).not.toContain("gajae-progress-time");
  });
});

describe("GajaeProgressRow with no signed-in provider", () => {
  const withHint = (needsSignIn: boolean, kind: "error" | "thinking") =>
    renderToStaticMarkup(
      createElement(
        LoginHintContext.Provider,
        { value: { needsSignIn, openLogin: () => undefined } },
        createElement(GajaeProgressRow, { kind, label: "오류가 났어요", onRetry: () => undefined }),
      ),
    );

  it("names the missing sign-in as the reason a turn failed and offers it", () => {
    const markup = withHint(true, "error");
    expect(markup).toContain("로그인한 AI가 없어 실행하지 못했어요");
    expect(markup).not.toContain("오류가 났어요");
    expect(markup).toContain("AI 로그인");
    expect(markup).toContain("다시 시도");
  });

  it("leaves a failure on a signed-in Mac, and any other state, as it was", () => {
    expect(withHint(false, "error")).toContain("오류가 났어요");
    expect(withHint(false, "error")).not.toContain("AI 로그인");
    expect(withHint(true, "thinking")).not.toContain("AI 로그인");
  });
});
