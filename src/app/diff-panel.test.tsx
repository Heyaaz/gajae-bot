/**
 * @vitest-environment happy-dom
 */
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitStatusSnapshot, DiffSnapshot } from "../../shared/agent-contract";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession, MessageInput } from "../backend/types";
import {
  Composer,
  composerQueue,
  saveComposerQueue,
  submitComposerInput,
} from "./composer";
import { DiffPanel } from "./inspector";
import { saveReviewComments } from "./review-model";

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

describe("diff review comments sent through the composer", () => {
  const reviewDiff: DiffSnapshot = {
    sessionId: "review",
    workspace: "/tmp/review",
    refreshedAt: "now",
    files: [
      {
        id: "a",
        path: "src/a.ts",
        patch: [
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -10,4 +10,3 @@",
          " const keep = 1;",
          "-const before = 2;",
          "-const gone = 3;",
          "+const after = 2;",
          " return keep;",
        ].join("\n"),
      },
      {
        id: "b",
        path: "src/b.ts",
        patch: ["@@ -4,2 +4,3 @@", " four();", "+added();", " end();"].join("\n"),
      },
    ],
  };
  const backend = {
    getGitStatus: () => Promise.resolve(status("/tmp/review", [])),
  } as unknown as AgentBackend;
  let root: Root;
  let host: HTMLDivElement;
  let sessionId: string;

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    saveComposerQueue(sessionId, []);
    saveReviewComments(sessionId, []);
  });

  // The same wiring the shell passes to both DiffPanel and Composer.
  function screen(
    running: boolean,
    send: (input: MessageInput) => Promise<undefined>,
    panelOpen = true,
  ) {
    const target = { ...session(sessionId, "/tmp/review"), status: running ? "running" as const : "idle" as const };
    return createElement(
      Fragment,
      null,
      panelOpen &&
        createElement(DiffPanel, {
          session: target,
          backend,
          diff: reviewDiff,
          loading: false,
          onRefresh: () => undefined,
          onClose: () => undefined,
          onSubmitReview: (id, text) =>
            submitComposerInput(id, { text, images: [], files: [] }, {
              running,
              runningSubmission: "queue",
              send,
            }),
        }),
      createElement(Composer, {
        sessionId,
        running,
        sessionTitle: "review",
        workspace: "/tmp/review",
        workspaces: ["/tmp/review"],
        commands: [],
        configOptions: [],
        runningSubmission: "queue",
        onSend: send,
        onCancel: async () => undefined,
        onFlushQueued: async () => undefined,
        onCompact: () => undefined,
        onNewSession: () => undefined,
        onWorkspaceChange: () => undefined,
        onConfigChange: () => undefined,
        onCycleThinking: () => undefined,
      }),
    );
  }

  async function mount(element: ReturnType<typeof screen>): Promise<void> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(element));
  }

  function lineButton(code: string): HTMLButtonElement {
    const row = [...host.querySelectorAll(".diff-line")].find(
      (candidate) => candidate.querySelector("code")?.textContent === code,
    );
    return row!.querySelector("button") as HTMLButtonElement;
  }

  function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
    return [...scope.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) as HTMLButtonElement;
  }

  async function type(field: HTMLTextAreaElement, text: string): Promise<void> {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!
        .set!.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function comment(from: string, to: string | null, body: string): Promise<void> {
    await act(async () => lineButton(from).click());
    if (to)
      await act(async () =>
        lineButton(to).dispatchEvent(
          new MouseEvent("click", { bubbles: true, shiftKey: true }),
        ),
      );
    const form = host.querySelector(".diff-comment-form") as HTMLFormElement;
    await type(form.querySelector("textarea")!, body);
    await act(async () => buttonIn(form, "코멘트 추가").click());
  }

  function card(location: string): HTMLElement {
    return [...host.querySelectorAll<HTMLElement>(".diff-review-card")].find(
      (candidate) =>
        candidate.querySelector(".diff-review-location")?.textContent === location,
    )!;
  }

  const expectedReview = [
    "다음 코드 리뷰 코멘트를 반영해 주세요.",
    "",
    "1. src/a.ts:10-12",
    "```diff",
    " const keep = 1;",
    "-const before = 2;",
    "-const gone = 3;",
    "+const after = 2;",
    " return keep;",
    "```",
    "inline the constant",
    "",
    "2. src/b.ts:5",
    "```diff",
    "+added();",
    "```",
    "check the call",
  ].join("\n");

  it("holds the whole review as one row while a turn is running, after edits and a delete", async () => {
    sessionId = `review-${crypto.randomUUID()}`;
    const send = vi.fn(async (_input: MessageInput) => undefined);
    await mount(screen(true, send));

    await comment(" const keep = 1;", " return keep;", "first draft");
    await comment("+added();", null, "check the call");
    await comment("-const gone = 3;", null, "drop me");
    expect(host.querySelectorAll(".diff-review-card")).toHaveLength(3);
    expect(card("src/a.ts:12 (변경 전)")).toBeDefined();

    await act(async () => buttonIn(card("src/a.ts:10-12"), "수정").click());
    await type(card("src/a.ts:10-12").querySelector("textarea")!, "inline the constant");
    await act(async () => buttonIn(card("src/a.ts:10-12"), "저장").click());
    await act(async () => buttonIn(card("src/a.ts:12 (변경 전)"), "삭제").click());
    expect(host.querySelectorAll(".diff-review-card")).toHaveLength(2);

    await act(async () => buttonIn(host, "리뷰 보내기").click());

    expect(send).not.toHaveBeenCalled();
    expect(composerQueue(sessionId)).toEqual([
      expect.objectContaining({ text: expectedReview, mode: "followUp" }),
    ]);
    const rows = host.querySelectorAll(".composer-queue-text");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toBe(expectedReview);
    expect(host.querySelector(".diff-review")).toBeNull();
  });

  it("sends the review once when idle, and keeps drafts across closing the panel", async () => {
    sessionId = `review-${crypto.randomUUID()}`;
    const send = vi.fn(async (_input: MessageInput) => undefined);
    await mount(screen(false, send));

    await comment(" const keep = 1;", " return keep;", "inline the constant");
    await act(async () => root.render(screen(false, send, false)));
    await act(async () => root.render(screen(false, send, true)));
    await comment("+added();", null, "check the call");

    await act(async () => buttonIn(host, "리뷰 보내기").click());

    expect(send).toHaveBeenCalledExactlyOnceWith({
      text: expectedReview,
      images: [],
      files: [],
    });
    expect(composerQueue(sessionId)).toEqual([]);
    expect(host.querySelector(".composer-queue-text")).toBeNull();
  });
});
