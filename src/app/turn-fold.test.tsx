/**
 * @vitest-environment happy-dom
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolViewMode, TranscriptItem } from "../backend/types";
import {
  foldTranscriptBlocks,
  lastTurnSettled,
  turnFoldContaining,
  turnFolds,
} from "../transcript-utils";
import { Transcript } from "./transcript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = (id: string, createdAt = "10:00"): TranscriptItem => ({
  id, sessionId: "s-1", kind: "message", role: "user", content: `ask ${id}`, createdAt,
});
const answer = (id: string, createdAt = "10:00", streaming = false): TranscriptItem => ({
  id, sessionId: "s-1", kind: "message", role: "assistant", content: `answer ${id}`, createdAt, streaming,
});
const tool = (id: string, status: "completed" | "failed" | "approval-required" = "completed"): TranscriptItem => ({
  id, sessionId: "s-1", kind: "tool", name: "bash", description: `run ${id}`, status, createdAt: "10:01",
});
const thought = (id: string): TranscriptItem => ({
  id, sessionId: "s-1", kind: "thought", content: `thinking ${id}`, createdAt: "10:01", streaming: false,
});

describe("turnFolds", () => {
  it("folds what lies between the prompt and the last answer, with its minutes and failures", () => {
    const items = [
      user("u1", "10:00"), thought("r1"), tool("t1"), answer("a0", "10:02"), tool("t2", "failed"), answer("a1", "10:07"),
    ];
    expect(turnFolds(items, true)).toEqual([
      { id: "u1", start: 1, end: 5, minutes: 7, failedCount: 1 },
    ]);
  });

  it("leaves the newest turn open until it has settled", () => {
    const items = [user("u1"), tool("t1"), answer("a1"), user("u2"), tool("t2"), answer("a2")];
    expect(turnFolds(items, false).map((fold) => fold.id)).toEqual(["u1"]);
    expect(turnFolds(items, true).map((fold) => fold.id)).toEqual(["u1", "u2"]);
  });

  it("keeps turns open with no answer, a streaming answer, nothing to fold, or a waiting approval", () => {
    expect(turnFolds([user("u1"), tool("t1")], true)).toEqual([]);
    expect(turnFolds([user("u1"), tool("t1"), answer("a1", "10:00", true)], true)).toEqual([]);
    expect(turnFolds([user("u1"), answer("a1")], true)).toEqual([]);
    expect(turnFolds([user("u1"), tool("t1", "approval-required"), answer("a1")], true)).toEqual([]);
  });

  it("counts minutes across midnight and gives up on a label it cannot read", () => {
    expect(turnFolds([user("u1", "23:58"), tool("t1"), answer("a1", "00:03")], true)[0]?.minutes).toBe(5);
    expect(turnFolds([user("u1", "now"), tool("t1"), answer("a1", "10:03")], true)[0]?.minutes).toBeNull();
    expect(turnFolds(
      [user("u1", "2026-11-01T10:00:00Z"), tool("t1"), answer("a1", "2026-11-01T10:02:30Z")], true,
    )[0]?.minutes).toBe(2);
  });
});

describe("foldTranscriptBlocks", () => {
  const items = [user("u1"), tool("t1"), tool("t2"), answer("a1"), user("u2")];
  const folds = turnFolds(items, true);

  it("shows a closed fold as one row in place of its items", () => {
    expect(foldTranscriptBlocks(items, folds, new Set()).map((block) => block.id)).toEqual([
      "u1", "fold-u1", "a1", "u2",
    ]);
  });

  it("follows an open fold with its own blocks", () => {
    expect(foldTranscriptBlocks(items, folds, new Set(["u1"])).map((block) => block.id)).toEqual([
      "u1", "fold-u1", "tools-t1", "a1", "u2",
    ]);
  });

  it("finds the fold an item is inside", () => {
    expect(turnFoldContaining(items, folds, "t2")?.id).toBe("u1");
    expect(turnFoldContaining(items, folds, "a1")).toBeUndefined();
  });
});

describe("lastTurnSettled", () => {
  it("is false while the session runs and true once it is idle or failed", () => {
    const items = [user("u1"), answer("a1")];
    expect(lastTurnSettled(items, { status: "running" })).toBe(false);
    expect(lastTurnSettled(items, { status: "idle" })).toBe(true);
    expect(lastTurnSettled(items, { status: "failed" })).toBe(true);
  });
});

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe("Transcript turn folds", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(2_000);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function render(items: TranscriptItem[], toolViewMode: ToolViewMode = "reasoning") {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(Transcript, {
          sessionId: "s-1",
          items,
          toolViewMode,
          turnSession: { status: "idle" },
          onResolveTool: () => undefined,
        }) as ReactNode,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    return host;
  }

  const items = [user("u1", "10:00"), tool("t1"), tool("t2", "failed"), answer("a1", "10:04")];

  it("shows the prompt, one work line, and the answer, and opens the work on a click", async () => {
    const view = await render(items);
    const toggle = view.querySelector<HTMLButtonElement>(".turn-fold button")!;
    expect(toggle.textContent).toBe("4분 동안 작업함실패 1개");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(view.textContent).toContain("ask u1");
    expect(view.textContent).toContain("answer a1");
    expect(view.textContent).not.toContain("run t1");

    await act(async () => toggle.click());
    expect(view.querySelector(".turn-fold button")!.getAttribute("aria-expanded")).toBe("true");
    expect(view.textContent).toContain("run t1");
  });

  it("does not fold in the detailed view", async () => {
    const view = await render(items, "detailed");
    expect(view.querySelector(".turn-fold")).toBeNull();
    expect(view.textContent).toContain("run t1");
  });
});
