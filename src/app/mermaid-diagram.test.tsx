/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../backend/types";
import { TranscriptItemView } from "./transcript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaidMock }));

const noop = () => undefined;

function assistantMessage(content: string, streaming = false): TranscriptItem {
  return {
    id: "msg-1",
    sessionId: "session-1",
    kind: "message",
    role: "assistant",
    content,
    createdAt: "now",
    streaming,
  };
}

function fence(source: string): string {
  return "```mermaid\n" + source + "\n```";
}

describe("mermaid diagrams in assistant messages", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  beforeEach(() => {
    mermaidMock.initialize.mockReset();
    mermaidMock.render.mockReset();
    mermaidMock.render.mockImplementation(async (id: string, source: string) => ({
      svg: `<svg id="${id}" data-source="${source.split("\n")[0]}"><text>그림</text></svg>`,
    }));
    document.documentElement.dataset.theme = "dark";
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  async function render(item: TranscriptItem): Promise<HTMLElement> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(TranscriptItemView, {
          item,
          onResolveTool: noop,
          onReadArtifact: noop,
        } as never),
      );
    });
    return host;
  }

  it("draws a settled mermaid fence as a diagram with a source toggle and copy button", async () => {
    const view = await render(assistantMessage(fence("flowchart LR\n  A[\"견적\"] --> B[\"결제\"]")));
    const diagram = view.querySelector(".mermaid-diagram");
    expect(diagram?.querySelector("svg")).not.toBeNull();
    expect(view.querySelector(".mermaid-scroll")).not.toBeNull();
    expect(view.querySelector(".code-block-copy")).not.toBeNull();
    expect(view.querySelector("pre")).toBeNull();
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", startOnLoad: false }),
    );

    const toggle = view.querySelector<HTMLButtonElement>("button[aria-pressed]");
    await act(async () => toggle?.click());
    expect(view.querySelector(".mermaid-diagram")).toBeNull();
    expect(view.querySelector("pre")?.textContent).toContain("견적");
  });

  it("leaves ordinary code blocks as they were", async () => {
    const view = await render(assistantMessage("```ts\nconst x = 1;\n```"));
    expect(view.querySelector(".mermaid-block")).toBeNull();
    expect(view.querySelector(".code-block-lang")?.textContent).toBe("ts");
    expect(view.querySelector("pre")?.textContent).toContain("const x = 1;");
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it("keeps the source of a streaming message instead of drawing it", async () => {
    const view = await render(
      assistantMessage(`${fence("flowchart TD\n  S --> T")}\n\n다음 문단`, true),
    );
    expect(view.querySelector(".mermaid-diagram")).toBeNull();
    expect(view.querySelector("pre")?.textContent).toContain("flowchart TD");
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it("keeps the source and says so when mermaid cannot draw it", async () => {
    mermaidMock.render.mockRejectedValue(new Error("Parse error"));
    const view = await render(assistantMessage(fence("flowchart TD\n  A -->")));
    expect(view.querySelector(".mermaid-diagram")).toBeNull();
    expect(view.querySelector("pre")?.textContent).toContain("A -->");
    expect(view.querySelector(".mermaid-note")?.textContent).toBe("다이어그램을 그리지 못했습니다");
  });

  it("draws every diagram in one message", async () => {
    const view = await render(
      assistantMessage(
        `${fence("flowchart LR\n  P --> Q")}\n\n사이 문단\n\n${fence("sequenceDiagram\n  U->>S: 요청")}`,
      ),
    );
    const sources = [...view.querySelectorAll(".mermaid-diagram svg")].map((svg) =>
      svg.getAttribute("data-source"),
    );
    expect(sources).toEqual(["flowchart LR", "sequenceDiagram"]);
  });

  it("redraws with the other palette when the theme changes", async () => {
    const view = await render(assistantMessage(fence("flowchart LR\n  M --> N")));
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    await act(async () => {
      document.documentElement.dataset.theme = "light";
    });
    expect(view.querySelector(".mermaid-diagram svg")).not.toBeNull();
    expect(mermaidMock.render).toHaveBeenCalledTimes(2);
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        themeVariables: expect.objectContaining({ darkMode: "false" }),
      }),
    );
  });
});
