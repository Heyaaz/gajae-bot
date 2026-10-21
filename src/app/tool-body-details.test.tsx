/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactContent, ToolActivity } from "../../shared/agent-contract";
import { ToolCard } from "./transcript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;

function tool(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: "tool-1",
    kind: "tool",
    sessionId: "session-1",
    name: "bash",
    description: "Run command",
    command: "input preview",
    status: "completed",
    createdAt: "now",
    ...overrides,
  };
}

function artifact(artifactId: string, text: string): ArtifactContent {
  return { artifactId, text, complete: true, totalBytes: new TextEncoder().encode(text).length };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("ToolCard original input and output details", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  async function mount(
    row: ToolActivity,
    onReadArtifact: (artifactId: string) => Promise<ArtifactContent>,
  ) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const render = (next: ToolActivity) =>
      root!.render(
        createElement(ToolCard, {
          tool: next,
          onResolve: noop,
          onReadArtifact,
        }),
      );
    await act(async () => render(row));
    return { node: host, render };
  }

  async function flushPromises() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("loads both complete bodies only after expansion and does not refetch identical rows", async () => {
    const input = `${"input-padding-".repeat(50)}INPUT_FULL_SENTINEL${"more-input-".repeat(50)}`;
    const output = `${"output-padding-".repeat(500)}OUTPUT_FULL_SENTINEL${"more-output-".repeat(500)}`;
    const row = tool({
      command: input,
      output,
      inputArtifactId: "gajae-transcript-body-input",
      outputArtifactId: "gajae-transcript-body-output",
    });
    const readArtifact = vi.fn(async (id: string) =>
      artifact(id, id.endsWith("input") ? input : output),
    );
    const view = await mount(row, readArtifact);

    expect(readArtifact).not.toHaveBeenCalled();
    expect(view.node.textContent).not.toContain("INPUT_FULL_SENTINEL");
    expect(view.node.textContent).not.toContain("OUTPUT_FULL_SENTINEL");

    await act(async () => view.node.querySelector<HTMLButtonElement>(".tool-expand")!.click());
    await flushPromises();

    expect(readArtifact).toHaveBeenCalledTimes(2);
    expect(readArtifact).toHaveBeenCalledWith("gajae-transcript-body-input");
    expect(readArtifact).toHaveBeenCalledWith("gajae-transcript-body-output");
    expect(view.node.textContent).toContain("INPUT_FULL_SENTINEL");
    expect(view.node.textContent).toContain("OUTPUT_FULL_SENTINEL");
    expect([...view.node.querySelectorAll(".tool-full-details section pre")].map((pre) => pre.textContent)).toEqual([
      input,
      output,
    ]);

    await act(async () => view.render(row));
    expect(readArtifact).toHaveBeenCalledTimes(2);
  });

  it("shows a field-specific read error instead of preview text and retries that field", async () => {
    const input = `${"before-".repeat(60)}INPUT_RETRIED_SENTINEL${"after-".repeat(60)}`;
    const output = "OUTPUT_ORIGINAL_SENTINEL";
    let inputReads = 0;
    const readArtifact = vi.fn(async (id: string) => {
      if (id.endsWith("input") && inputReads++ === 0) {
        throw new Error("input read failed");
      }
      return artifact(id, id.endsWith("input") ? input : output);
    });
    const view = await mount(
      tool({
        command: input,
        output,
        inputArtifactId: "gajae-transcript-body-input",
        outputArtifactId: "gajae-transcript-body-output",
      }),
      readArtifact,
    );

    await act(async () => view.node.querySelector<HTMLButtonElement>(".tool-expand")!.click());
    await flushPromises();

    const inputSection = [...view.node.querySelectorAll(".tool-full-details section")].find(
      (section) => section.querySelector("strong")?.textContent === "입력",
    )!;
    expect(inputSection.textContent).toContain("input read failed");
    expect(inputSection.querySelector("pre")).toBeNull();
    expect(view.node.textContent).toContain("OUTPUT_ORIGINAL_SENTINEL");

    await act(async () => inputSection.querySelector<HTMLButtonElement>(".tool-body-retry--input")!.click());
    await flushPromises();

    expect(readArtifact).toHaveBeenCalledTimes(3);
    expect(view.node.textContent).toContain("INPUT_RETRIED_SENTINEL");
    expect(view.node.textContent).toContain("OUTPUT_ORIGINAL_SENTINEL");
  });

  it("ignores a pending response when the artifact reference changes", async () => {
    const oldRead = deferred<ArtifactContent>();
    const newRead = deferred<ArtifactContent>();
    const readArtifact = vi.fn((id: string) =>
      id.endsWith("old") ? oldRead.promise : newRead.promise,
    );
    const view = await mount(
      tool({ inputArtifactId: "gajae-transcript-body-old" }),
      readArtifact,
    );

    await act(async () => view.node.querySelector<HTMLButtonElement>(".tool-expand")!.click());
    expect(readArtifact).toHaveBeenCalledTimes(1);
    await act(async () => view.render(tool({ inputArtifactId: "gajae-transcript-body-new" })));
    expect(readArtifact).toHaveBeenCalledTimes(2);

    await act(async () => oldRead.resolve(artifact("old", "STALE_OLD_BODY")));
    await flushPromises();
    expect(view.node.textContent).not.toContain("STALE_OLD_BODY");

    await act(async () => newRead.resolve(artifact("new", "CURRENT_NEW_BODY")));
    await flushPromises();
    expect(view.node.textContent).toContain("CURRENT_NEW_BODY");
  });

  it("ignores an in-flight response after collapse and reloads on a later expansion", async () => {
    const pendingReads = [deferred<ArtifactContent>(), deferred<ArtifactContent>()];
    const readArtifact = vi.fn(() => pendingReads[readArtifact.mock.calls.length - 1]!.promise);
    const view = await mount(
      tool({ inputArtifactId: "gajae-transcript-body-input" }),
      readArtifact,
    );

    await act(async () => view.node.querySelector<HTMLButtonElement>(".tool-expand")!.click());
    expect(readArtifact).toHaveBeenCalledTimes(1);
    await act(async () => view.node.querySelector<HTMLButtonElement>(".tool-expand")!.click());
    await act(async () => pendingReads[0]!.resolve(artifact("input", "COLLAPSED_STALE_BODY")));
    await flushPromises();
    expect(view.node.textContent).not.toContain("COLLAPSED_STALE_BODY");

    await act(async () => view.node.querySelector<HTMLButtonElement>(".tool-expand")!.click());
    expect(readArtifact).toHaveBeenCalledTimes(2);
    await act(async () => pendingReads[1]!.resolve(artifact("input", "AFTER_REEXPAND_BODY")));
    await flushPromises();
    expect(view.node.textContent).toContain("AFTER_REEXPAND_BODY");
  });
});
