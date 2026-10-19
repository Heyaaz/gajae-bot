import { createElement, type ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeferredProjectList } from "./deferred-views";

async function markup(node: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(node);
  await stream.allReady;
  return await new Response(stream).text();
}

describe("deferred screens", () => {
  it("shows the project list after its chunk loads", async () => {
    const html = await markup(
      createElement(DeferredProjectList, {
        projects: [],
        activeId: "all",
        onSelect: () => undefined,
        onOpenRepository: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).toContain("프로젝트 목록");
    expect(html).toContain("프로젝트가 없습니다. 세션을 만들면 그 작업 폴더가 프로젝트가 됩니다.");
  });
});
