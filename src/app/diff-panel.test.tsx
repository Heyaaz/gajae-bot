/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitStatusSnapshot, DiffSnapshot } from "../../shared/agent-contract";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import { DiffPanel } from "./inspector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function session(id: string, workspace: string): AgentSession {
  return {
    id,
    title: id,
    subtitle: "gajae-bot",
    workspace,
    runtime: "gjc",
    status: "idle",
    updatedAt: "10:00",
    updatedAtMs: 1,
    pinned: false,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
    worktree: {
      sourceWorkspace: `/tmp/${id}`,
      path: workspace,
      branch: `work/${id}`,
      managed: true,
    },
  };
}

function status(
  workspace: string,
  paths: string[],
): GitStatusSnapshot {
  return {
    workspace,
    branch: "main",
    ahead: 0,
    behind: 0,
    files: paths.map((path) => ({ path, index: " ", workingTree: "M" })),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const emptyDiff: DiffSnapshot = {
  sessionId: "a",
  workspace: "/tmp/a",
  files: [],
  refreshedAt: "now",
};

describe("diff panel session ownership", () => {
  const gitStatus = vi.fn<(sessionId: string) => Promise<GitStatusSnapshot>>();
  const stageFiles = vi.fn<
    (sessionId: string, paths: string[]) => Promise<GitStatusSnapshot>
  >();
  const backend = {
    getGitStatus: gitStatus,
    stageFiles,
    unstageFiles: vi.fn(),
    commitChanges: vi.fn(),
    pushChanges: vi.fn(),
  } as unknown as AgentBackend;
  const onRefresh = vi.fn();
  let root: Root;
  let host: HTMLDivElement;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    gitStatus.mockReset();
    stageFiles.mockReset();
    onRefresh.mockReset();
  });

  function element(target: AgentSession) {
    return createElement(DiffPanel, {
      session: target,
      backend,
      diff: emptyDiff,
      loading: false,
      onRefresh,
      onClose: () => undefined,
    });
  }

  async function show(target: AgentSession): Promise<void> {
    await act(async () => {
      root.render(element(target));
    });
  }

  async function mount(target: AgentSession): Promise<void> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await show(target);
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  function checkbox(): HTMLInputElement {
    return host.querySelector(".git-file-list input") as HTMLInputElement;
  }

  function button(label: string): HTMLButtonElement {
    return [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) as HTMLButtonElement;
  }

  it("drops a previous session's late status instead of showing it", async () => {
    const first = deferred<GitStatusSnapshot>();
    const second = deferred<GitStatusSnapshot>();
    gitStatus.mockImplementation((sessionId) =>
      sessionId === "a" ? first.promise : second.promise,
    );
    await mount(session("a", "/tmp/a"));
    await show(session("b", "/tmp/b"));

    first.resolve(status("/tmp/a", ["only-in-a.txt"]));
    await settle();
    expect(host.textContent).not.toContain("only-in-a.txt");

    second.resolve(status("/tmp/b", ["only-in-b.txt"]));
    await settle();
    expect(host.textContent).toContain("only-in-b.txt");
    expect(host.textContent).not.toContain("only-in-a.txt");
  });

  it("never stages a selection made under the previous session", async () => {
    const first = deferred<GitStatusSnapshot>();
    const second = deferred<GitStatusSnapshot>();
    gitStatus.mockImplementation((sessionId) =>
      sessionId === "a" ? first.promise : second.promise,
    );
    await mount(session("a", "/tmp/a"));
    first.resolve(status("/tmp/a", ["shared-file.txt"]));
    await settle();
    act(() => checkbox().click());
    expect(checkbox().checked).toBe(true);

    // Same relative path in another repository: the old check must not carry over.
    await show(session("b", "/tmp/b"));
    expect(host.textContent).not.toContain("shared-file.txt");
    expect(button("Stage").disabled).toBe(true);

    second.resolve(status("/tmp/b", ["shared-file.txt"]));
    await settle();
    expect(checkbox().checked).toBe(false);
    stageFiles.mockResolvedValue(status("/tmp/b", ["shared-file.txt"]));
    act(() => checkbox().click());
    await act(async () => {
      button("Stage").click();
    });
    expect(stageFiles).toHaveBeenCalledWith("b", ["shared-file.txt"]);
    expect(stageFiles).not.toHaveBeenCalledWith("a", ["shared-file.txt"]);
  });

  it("keeps each session's commit draft with that session", async () => {
    gitStatus.mockImplementation((sessionId) =>
      Promise.resolve(status(`/tmp/${sessionId}`, [])),
    );
    await mount(session("a", "/tmp/a"));
    await settle();
    const input = host.querySelector(
      ".commit-row input",
    ) as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setValue.call(input, "draft for a");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      (host.querySelector(".commit-row input") as HTMLInputElement).value,
    ).toBe("draft for a");

    await show(session("b", "/tmp/b"));
    expect(
      (host.querySelector(".commit-row input") as HTMLInputElement).value,
    ).toBe("");

    await show(session("a", "/tmp/a"));
    expect(
      (host.querySelector(".commit-row input") as HTMLInputElement).value,
    ).toBe("draft for a");
  });
});
