/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInspection } from "../../shared/settings-ipc";
import { NewSessionDialog, type NewSessionInput } from "./dialogs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  Reflect.deleteProperty(window, "agentControlDesktop");
});

async function open(
  workspace: string,
  inspections: Record<string, WorkspaceInspection>,
  picked: string | null = null,
) {
  const onCreate = vi.fn<(input: NewSessionInput) => void>();
  const chooseWorkspace = vi.fn(async () => picked);
  Object.assign(window, {
    agentControlDesktop: {
      settings: {
        chooseWorkspace,
        inspectWorkspace: async (path: string) => inspections[path] ?? { broad: false, git: false },
      },
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(createElement(NewSessionDialog, { defaultWorkspace: workspace, onCancel: () => undefined, onCreate })),
  );
  return { node: host, onCreate, chooseWorkspace };
}

const button = (node: HTMLElement, text: string) =>
  [...node.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));

const submit = (node: HTMLElement) =>
  act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

describe("a broad project folder", () => {
  const docs = { "/home/kim/Documents": { broad: true, git: false } };

  it("warns, makes folder choice the main action, and does not start on Enter", async () => {
    const { node, onCreate } = await open("/home/kim/Documents", docs);

    expect(node.querySelector(".broad-workspace-warning")?.textContent).toContain("모든 파일을 읽고 바꿀 수 있습니다");
    expect(button(node, "폴더 선택…")?.className).toContain("button-primary");
    expect(button(node, "이 폴더에서 그대로 시작")?.className).toContain("button-secondary");
    expect(button(node, "세션 만들기")).toBeUndefined();

    await submit(node);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("starts there only through the explicit secondary action", async () => {
    const { node, onCreate } = await open("/home/kim/Documents", docs);
    await act(async () => button(node, "이 폴더에서 그대로 시작")!.click());
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspace: "/home/kim/Documents", title: "새 세션" }),
    );
  });

  it("returns to the plain create button once a project folder is chosen", async () => {
    const { node, onCreate, chooseWorkspace } = await open("/home/kim/Documents", docs, "/home/kim/pro/app");
    await act(async () => button(node, "폴더 선택…")!.click());

    expect(chooseWorkspace).toHaveBeenCalledOnce();
    expect(node.querySelector(".broad-workspace-warning")).toBeNull();
    await submit(node);
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspace: "/home/kim/pro/app" }));
  });
});

describe("the isolation choice", () => {
  it("shows plain Korean with a tooltip for a git repository", async () => {
    const { node } = await open("/work/app", { "/work/app": { broad: false, git: true } });
    const fieldset = node.querySelector("fieldset.isolation-options");
    expect(fieldset?.textContent).toContain("지금 폴더에서 바로 작업");
    expect(fieldset?.textContent).toContain("별도 복사본에서 작업");
    expect(fieldset?.textContent).not.toContain("worktree 생성");
    expect(fieldset?.querySelector("label[title]")?.getAttribute("title")).toContain("새 폴더에 복사");
  });

  it("is hidden for a folder that is not a git repository", async () => {
    const { node } = await open("/work/notes", { "/work/notes": { broad: false, git: false } });
    expect(node.querySelector("fieldset.isolation-options")).toBeNull();
  });
});
