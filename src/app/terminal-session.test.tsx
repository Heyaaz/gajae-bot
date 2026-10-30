/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../backend/types";
import { NewSessionDialog, type NewSessionInput } from "./dialogs";
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

const noop = () => undefined;

function row(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    title: id,
    subtitle: "repo",
    workspace: "/repo",
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    pinned: false,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
    ...overrides,
  };
}

describe("new session dialog", () => {
  const submit = (node: HTMLElement) =>
    act(async () =>
      node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );

  it("asks only for the name, isolation, and folder of a GJC session", async () => {
    const onCreate = vi.fn<(input: NewSessionInput) => void>();
    const node = await mount(
      createElement(NewSessionDialog, { defaultWorkspace: "/repo", onCancel: noop, onCreate }),
    );
    expect(node.querySelector("h2")?.textContent).toBe("새 GJC 세션");
    expect(node.querySelector("fieldset.isolation-options")).not.toBeNull();
    expect(node.querySelector("textarea")).toBeNull();
    expect(node.querySelector("fieldset.parallel-options")).toBeNull();
    expect(node.querySelector('input[name="session-kind"]')).toBeNull();

    await submit(node);
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      title: "새 Gajae 세션",
      workspace: "/repo",
      isolation: "workspace",
      worktreeBranch: undefined,
      initialPrompt: undefined,
      initialImages: undefined,
    });
  });

  it("opens a CLI session, named after its folder, when the settings choose CLI", async () => {
    const onCreate = vi.fn<(input: NewSessionInput) => Promise<void>>().mockResolvedValue();
    const node = await mount(
      createElement(NewSessionDialog, {
        defaultWorkspace: "/work/repo",
        kind: "terminal",
        onCancel: noop,
        onCreate,
      }),
    );
    expect(node.querySelector("h2")?.textContent).toBe("새 터미널 세션");
    expect(node.querySelector("fieldset.isolation-options")).toBeNull();

    await submit(node);
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      title: "repo",
      workspace: "/work/repo",
      kind: "terminal",
    });
  });

  it("keeps a handed-over request on a GJC session even when the settings choose CLI", async () => {
    const onCreate = vi.fn<(input: NewSessionInput) => void>();
    const node = await mount(
      createElement(NewSessionDialog, {
        defaultWorkspace: "/repo",
        kind: "terminal",
        prefill: { prompt: "  CI를 고쳐 줘 " },
        onCancel: noop,
        onCreate,
      }),
    );
    expect(node.querySelector("h2")?.textContent).toBe("새 GJC 세션");

    await submit(node);
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ initialPrompt: "CI를 고쳐 줘" });
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty("kind");
  });
});

describe("terminal session row", () => {
  it("marks the row as a terminal and leaves only rename and delete in its menu", async () => {
    const node = await mount(
      createElement(Sidebar, {
        sessions: [row("terminal-1", { runtime: "terminal", title: "셸" })],
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
        onSelect: noop,
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
        parallelGroups: [],
        openParallelGroupId: null,
        onOpenParallelGroup: noop,
      }),
    );
    const sessionRow = node.querySelector<HTMLElement>(".session-row")!;
    expect(sessionRow.querySelector('[aria-label="터미널 세션"]')).not.toBeNull();
    expect(sessionRow.querySelector(".session-state-dot")).toBeNull();

    await act(async () =>
      sessionRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })),
    );
    const items = [...node.querySelectorAll<HTMLButtonElement>(".session-context-menu button")].map(
      (button) => button.textContent?.trim() ?? "",
    );
    expect(items).toEqual(["이름 변경", "삭제"]);
  });
});
