/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffSnapshot } from "../../shared/agent-contract";
import type { ParallelDesktopBridge } from "../../shared/parallel-ipc";
import type { ParallelGroup } from "../../shared/parallel-run";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import { NewSessionDialog, type NewSessionInput } from "./dialogs";
import { ParallelView } from "./parallel-view";
import { Sidebar } from "./sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});

async function mount(element: ReturnType<typeof createElement>): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
  return host;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, event: "input" | "change"): void {
  const prototype = Object.getPrototypeOf(element) as object;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(event, { bubbles: true }));
}

const button = (node: ParentNode, label: string) =>
  [...node.querySelectorAll("button")].find((element) => element.textContent?.includes(label));

function session(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    title: `로그인 고치기 · ${id}`,
    subtitle: id,
    workspace: `/repo.gajae-worktrees/${id}`,
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    updatedAtMs: 10,
    pinned: false,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
    worktree: { sourceWorkspace: "/repo", path: `/repo.gajae-worktrees/${id}`, branch: `feat/login-${id}`, managed: true },
    ...overrides,
  };
}

function group(state: ParallelGroup["state"] = { kind: "comparing" }): ParallelGroup {
  return {
    id: "g1",
    title: "로그인 고치기",
    prompt: "로그인 버그를 고쳐 줘",
    workspace: "/repo",
    createdAt: 1,
    state,
    attempts: [
      { id: "1", preset: "codex-pro", branch: "feat/login-1", state: { kind: "started", sessionId: "a1", worktreePath: "/wt/1" } },
      { id: "2", preset: "codex-medium", branch: "feat/login-2", state: { kind: "failed", reason: "unknown model profile codex-medium" } },
      { id: "3", preset: "codex-eco", branch: "feat/login-3", state: { kind: "started", sessionId: "a3", worktreePath: "/wt/3" } },
    ],
  };
}

describe("the new-session dialog", () => {
  it("starts three attempts on their own presets in worktrees, with the request to send", async () => {
    const onCreate = vi.fn<(input: NewSessionInput) => void>();
    const node = await mount(
      createElement(NewSessionDialog, {
        defaultWorkspace: "/repo",
        parallel: { presets: ["codex-medium", "codex-eco", "codex-pro"], defaultPreset: "codex-medium" },
        onCancel: () => undefined,
        onCreate,
      }),
    );
    const count = node.querySelector<HTMLSelectElement>('select[aria-label="병렬 실행 시도 수"]')!;
    await act(async () => setValue(count, "3", "change"));

    const presets = [...node.querySelectorAll<HTMLInputElement>('input[aria-label$="모델 프리셋"]')];
    expect(presets.map((input) => input.value)).toEqual(["codex-medium", "codex-eco", "codex-pro"]);
    await act(async () => setValue(presets[1]!, "codex-pro", "input"));
    const radios = [...node.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => [radio.checked, radio.disabled])).toEqual([
      [false, true],
      [true, false],
    ]);
    const submit = node.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.textContent).toContain("시도 3개 시작");
    // Nothing to send yet: a parallel run without a request would create idle sessions.
    expect(submit.disabled).toBe(true);

    await act(async () => setValue(node.querySelector("textarea")!, "  로그인 버그를 고쳐 줘 ", "input"));
    await act(async () => setValue(node.querySelector<HTMLInputElement>("fieldset.isolation-options input:not([type])")!, "feat/login", "input"));
    await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      title: "새 Gajae 세션",
      workspace: "/repo",
      isolation: "worktree",
      worktreeBranch: "feat/login",
      initialPrompt: "로그인 버그를 고쳐 줘",
      parallelPresets: ["codex-medium", "codex-pro", "codex-pro"],
    });
  });

  it("keeps today's single session when the count stays at 1, and offers no parallel run for a CI fix", async () => {
    const onCreate = vi.fn<(input: NewSessionInput) => void>();
    const node = await mount(
      createElement(NewSessionDialog, {
        defaultWorkspace: "/repo",
        parallel: { presets: ["codex-medium"], defaultPreset: "codex-medium" },
        onCancel: () => undefined,
        onCreate,
      }),
    );
    await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty("parallelPresets");
    expect(onCreate.mock.calls[0]![0].isolation).toBe("workspace");

    act(() => root!.unmount());
    host!.remove();
    const ci = await mount(
      createElement(NewSessionDialog, {
        defaultWorkspace: "/repo",
        prefill: { isolation: "worktree", worktreeBranch: "feat/ci", worktreeBranchExisting: true },
        parallel: { presets: ["codex-medium"], defaultPreset: "codex-medium" },
        onCancel: () => undefined,
        onCreate,
      }),
    );
    expect(ci.querySelector('select[aria-label="병렬 실행 시도 수"]')).toBeNull();
  });
});

describe("the rail", () => {
  it("draws the attempts under one group row that opens the comparison", async () => {
    const onOpenParallelGroup = vi.fn();
    const onSelect = vi.fn();
    const noop = () => undefined;
    const node = await mount(
      createElement(Sidebar, {
        sessions: [session("a1", { status: "running" }), session("a3"), session("solo", { title: "다른 일", updatedAtMs: 1 })],
        connection: { state: "connected", backend: "gjc", label: "GJC", detail: "", workspace: "/repo" },
        selectedId: null,
        projects: [],
        projectId: "__all__",
        onProjectChange: noop,
        onOpenRepository: noop,
        onOpenProjects: noop,
        inboxCount: 0,
        inboxOpen: false,
        onToggleInbox: noop,
        onOpenProjectGithub: noop,
        onOpenProjectFolder: noop,
        searchQuery: "",
        onSearchChange: noop,
        onSearchOpen: noop,
        onSelect,
        onCreate: noop,
        onFork: noop,
        onResume: noop,
        onResumePicker: noop,
        onRename: noop,
        onDelete: noop,
        onHide: noop,
        onSettings: noop,
        workspaceLabel: "",
        onWorkspaceLabelChange: noop,
        updateStatus: null,
        updateBusy: false,
        onUpdate: noop,
        parallelGroups: [group({ kind: "running" })],
        openParallelGroupId: null,
        onOpenParallelGroup,
      }),
    );
    const rows = [...node.querySelectorAll<HTMLElement>(".session-row")];
    expect(rows.map((row) => [row.dataset.depth, row.querySelector("strong")?.textContent])).toEqual([
      ["0", "로그인 고치기"],
      ["1", "로그인 고치기 · a1"],
      ["1", "로그인 고치기 · a3"],
      ["0", "다른 일"],
    ]);
    const head = node.querySelector<HTMLElement>(".session-row--parallel")!;
    expect(head.textContent).toContain("병렬 3개");
    expect(head.textContent).toContain("병렬 실행 중");
    await act(async () => head.click());
    expect(onOpenParallelGroup).toHaveBeenCalledExactlyOnceWith("g1");
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("the comparison view", () => {
  function diff(sessionId: string, files: string[]): DiffSnapshot {
    return {
      sessionId,
      workspace: `/wt/${sessionId}`,
      refreshedAt: "now",
      files: files.map((path) => ({ id: path, path, patch: `@@ -1 +1 @@\n-old\n+new ${path}` })),
    };
  }

  function harness(current: ParallelGroup) {
    const calls: string[] = [];
    const backend = {
      getDiff: vi.fn(async (sessionId: string) =>
        sessionId === "a1" ? diff("a1", ["src/login.ts", "src/login.test.ts"]) : diff("a3", ["src/auth.ts"]),
      ),
      getGitStatus: vi.fn(async () => ({ workspace: "/wt", branch: "feat/login-1", ahead: 0, behind: 0, files: [] })),
    } as unknown as AgentBackend;
    const bridge: ParallelDesktopBridge = {
      list: async () => [current],
      start: vi.fn(),
      adopt: vi.fn(async (_groupId: string, attemptId: string) => {
        calls.push(`adopt ${attemptId}`);
        return { ...current, state: { kind: "adopted" as const, attemptId } };
      }),
      discard: vi.fn(),
      cleanup: vi.fn(async () => {
        calls.push("cleanup");
        throw new Error("Error invoking remote method 'agent-control:parallel:cleanup': Error: Operation cancelled");
      }),
      onChanged: () => () => undefined,
    };
    return { backend, bridge, calls };
  }

  it("shows each attempt's state, model, changed files and diff side by side, and adopts through the native confirmation", async () => {
    const current = group();
    const { backend, bridge, calls } = harness(current);
    const onError = vi.fn();
    const onOpenSession = vi.fn();
    const node = await mount(
      createElement(ParallelView, {
        group: current,
        sessions: [
          session("a1", { model: "codex-pro", usagePercent: 12.5 }),
          session("a3", { model: "codex-medium" }),
        ],
        backend,
        bridge,
        onOpenSession,
        onClose: () => undefined,
        onError,
      }),
    );
    await vi.waitFor(() => expect(node.textContent).toContain("변경 파일 2개"));
    const attempts = [...node.querySelectorAll<HTMLElement>(".parallel-attempt")];
    expect(attempts.map((attempt) => attempt.dataset.state)).toEqual(["started", "failed", "started"]);
    expect(attempts[0]!.textContent).toContain("실행 모델 codex-pro");
    expect(attempts[0]!.textContent).toContain("컨텍스트 12.5%");
    expect(attempts[1]!.textContent).toContain("실패: unknown model profile codex-medium");
    expect(attempts[2]!.textContent).toContain("변경 파일 1개");
    // The runtime reported a preset other than the one this attempt asked for.
    expect(attempts[2]!.querySelector(".parallel-attempt__warning")?.textContent).toContain("codex-medium");
    // Each attempt's diff is the session's own DiffPanel.
    expect(attempts[0]!.querySelector(".diff-panel")?.textContent).toContain("src/login.test.ts");
    expect(attempts[2]!.querySelector(".diff-panel")?.textContent).toContain("src/auth.ts");
    expect(attempts[1]!.querySelector(".diff-panel")).toBeNull();
    expect(button(attempts[1]!, "이 시도 채택")).toBeUndefined();

    await act(async () => button(attempts[2]!, "대화 열기")!.click());
    expect(onOpenSession).toHaveBeenCalledWith("a3");

    await act(async () => button(attempts[0]!, "이 시도 채택")!.click());
    await vi.waitFor(() => expect(calls).toEqual(["adopt 1", "cleanup"]));
    // Cancelling the native confirmation is an answer, not an error.
    expect(onError).not.toHaveBeenCalled();
  });

  it("offers the rest of the cleanup again after an adoption whose confirmation was cancelled", async () => {
    const current = group({ kind: "adopted", attemptId: "1" });
    const { backend, bridge } = harness(current);
    const node = await mount(
      createElement(ParallelView, {
        group: current,
        sessions: [session("a1", { model: "codex-pro" }), session("a3", { model: "codex-eco" })],
        backend,
        bridge,
        onOpenSession: () => undefined,
        onClose: () => undefined,
        onError: () => undefined,
      }),
    );
    expect(node.querySelector(".parallel-attempt__adopted")?.closest(".parallel-attempt")?.getAttribute("data-attempt")).toBe("1");
    expect(button(node, "모두 버리기")).toBeUndefined();
    await act(async () => button(node, "나머지 정리")!.click());
    expect(bridge.cleanup).toHaveBeenCalledExactlyOnceWith("g1");
  });
});
