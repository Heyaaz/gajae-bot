/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyViewBoundary } from "./lazy-boundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("lazy view error boundary", () => {
  let root: Root;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  it("keeps the shell mounted and offers a reload when a chunk fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function BrokenChunk(): never {
      throw new Error("chunk failed to load");
    }

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(
          LazyViewBoundary,
          null,
          createElement(BrokenChunk),
        ),
      );
    });

    expect(host.querySelector(".lazy-view-error")?.textContent).toContain(
      "화면을 불러오지 못했습니다.",
    );
    expect(host.querySelector(".lazy-view-error button")?.textContent).toContain(
      "다시 불러오기",
    );
    logged.mockRestore();
  });
});
