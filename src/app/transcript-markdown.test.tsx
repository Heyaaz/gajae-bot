/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../backend/types";

const parsed = vi.hoisted(() => ({ texts: [] as string[] }));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    parsed.texts.push(String(children));
    return createElement("div", { "data-markdown": "" }, String(children));
  },
}));

import { TranscriptItemView } from "./transcript";

const noop = () => undefined;

function assistant(content: string, streaming = false): TranscriptItem {
  return {
    id: "m-1",
    sessionId: "s-1",
    kind: "message",
    role: "assistant",
    content,
    streaming,
    createdAt: "now",
  };
}

function view(item: TranscriptItem) {
  return createElement(TranscriptItemView, {
    item,
    onResolveTool: noop,
    onReadArtifact: noop as never,
  });
}

describe("assistant markdown is parsed once per closed block", () => {
  let root: Root;
  let host: HTMLDivElement;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    parsed.texts.length = 0;
  });

  async function mount(node: ReturnType<typeof createElement>): Promise<void> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(node);
    });
  }

  it("does not parse a finished answer again when its row's parent renders", async () => {
    const item = assistant("**done**");
    function Parent() {
      const [tick, setTick] = useState(0);
      return createElement(
        "div",
        null,
        createElement("button", { type: "button", onClick: () => setTick((n) => n + 1) }, String(tick)),
        view(item),
      );
    }
    await mount(createElement(Parent));
    expect(parsed.texts).toEqual(["**done**"]);

    await act(async () => {
      host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(parsed.texts).toEqual(["**done**"]);
  });

  it("parses only the newly closed block while a reply streams", async () => {
    function Parent() {
      const [content, setContent] = useState("**a**\n\n");
      return createElement(
        "div",
        null,
        createElement(
          "button",
          {
            type: "button",
            onClick: () => setContent((current) =>
              current.endsWith("partial") ? current : `${current}**b**\n\npartial`,
            ),
          },
          "grow",
        ),
        view(assistant(content, true)),
      );
    }
    await mount(createElement(Parent));
    expect(parsed.texts).toEqual(["**a**\n\n"]);

    await act(async () => {
      host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(parsed.texts).toEqual(["**a**\n\n", "**b**\n\n"]);
    expect(host.textContent).toContain("partial");
  });
});
