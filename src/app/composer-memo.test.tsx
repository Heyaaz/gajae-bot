/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const bodyRuns = vi.hoisted(() => ({ n: 0 }));

vi.mock("../i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../i18n")>();
  return {
    ...actual,
    t: (text: string) => {
      bodyRuns.n += 1;
      return actual.t(text);
    },
  };
});

import { Composer, type ComposerProps } from "./composer";

const props: ComposerProps = {
  sessionId: "s-1",
  running: true,
  sessionTitle: "세션",
  workspace: "/tmp/gajae-bot",
  workspaces: ["/tmp/gajae-bot"],
  commands: [],
  configOptions: [],
  runningSubmission: "queue",
  onSend: async () => undefined,
  onCancel: async () => undefined,
  onFlushQueued: async () => undefined,
  onCompact: () => undefined,
  onNewSession: () => undefined,
  onWorkspaceChange: () => undefined,
  onConfigChange: () => undefined,
  onCycleThinking: () => undefined,
};

describe("Composer memo", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  it("does not run again when its parent renders with the same props", async () => {
    function Harness() {
      const [tick, setTick] = useState(0);
      return createElement(
        "div",
        null,
        createElement(
          "button",
          { type: "button", onClick: () => setTick((n) => n + 1) },
          String(tick),
        ),
        createElement(Composer, props),
      );
    }
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(Harness));
    });
    const settled = bodyRuns.n;
    expect(settled).toBeGreaterThan(0);

    await act(async () => {
      host!.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(bodyRuns.n).toBe(settled);
  });
});
