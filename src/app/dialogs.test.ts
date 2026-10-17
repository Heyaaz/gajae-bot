import { describe, expect, it, vi } from "vitest";
import { NewSessionDialog, sessionSummaryLine, workspaceLabelFor } from "./dialogs";

const hookState = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const slot = hookState.cursor++;
      if (!(slot in hookState.slots)) hookState.slots[slot] = initial;
      return [
        hookState.slots[slot],
        (next: unknown) => {
          hookState.slots[slot] = next;
        },
      ];
    },
  };
});

function renderNewSessionDialog() {
  hookState.cursor = 0;
  return NewSessionDialog({
    defaultWorkspace: "/original/project",
    onCancel: () => undefined,
    onCreate: () => undefined,
  });
}

function findElement(node: unknown, predicate: (element: any) => boolean): any {
  if (!node || typeof node !== "object") return undefined;
  const element = node as { type?: unknown; props?: { children?: unknown } };
  if (predicate(element)) return element;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return undefined;
}

describe("sessionSummaryLine", () => {
  it("keeps a short title exactly as it is", () => {
    expect(sessionSummaryLine("라우터 5초 고치기")).toBe("라우터 5초 고치기");
  });

  it("cuts a long first request down to one readable line", () => {
    // A session title is the whole first request, which runs to hundreds of
    // characters. Left alone it widened the row and pushed the id/time line out
    // of the dialog.
    const long =
      "운영 서버 이전을 해야하거든 ? [신규 클라우드 서버] CPU : 8vcore RAM : 16G SSD : 200G IP ADDRESS : 1.2.3.4 이런 스펙으로 옮기려고 하는데 어떤 순서로 진행하면 좋을지 알려줘";
    const summary = sessionSummaryLine(long);
    expect(summary.length).toBeLessThanOrEqual(72);
    expect(summary.endsWith("…")).toBe(true);
    expect(long.startsWith(summary.slice(0, -1).trimEnd())).toBe(true);
  });

  it("collapses the newlines a multi-line request carries", () => {
    expect(sessionSummaryLine("첫 줄\n\n둘째  줄")).toBe("첫 줄 둘째 줄");
  });
});

describe("NewSessionDialog workspace picker", () => {
  it("shows picker failures without losing the current workspace and keeps successful selections", async () => {
    hookState.slots = [];
    const chooseWorkspace = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("Folder access denied"))
      .mockResolvedValueOnce("/selected/project");
    vi.stubGlobal("window", {
      agentControlDesktop: { settings: { chooseWorkspace } },
    });

    let tree = renderNewSessionDialog();
    const picker = findElement(
      tree,
      (element) => element.type === "button" && element.props?.children === "선택…",
    );
    picker.props.onClick();
    await Promise.resolve();
    await Promise.resolve();

    tree = renderNewSessionDialog();
    const alert = findElement(
      tree,
      (element) => element.props?.role === "alert",
    );
    expect(alert.props.children).toBe("Folder access denied");
    const currentWorkspace = findElement(tree, (element) => element.type === "code");
    expect(currentWorkspace.props.children).toBe("/original/project");

    const successfulPicker = findElement(
      tree,
      (element) => element.type === "button" && element.props?.children === "선택…",
    );
    successfulPicker.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
    tree = renderNewSessionDialog();
    expect(findElement(tree, (element) => element.type === "code").props.children).toBe(
      "/selected/project",
    );
    expect(findElement(tree, (element) => element.props?.role === "alert")).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("workspaceLabelFor", () => {
  it("shortens a deep path to its project folder", () => {
    expect(workspaceLabelFor("/Users/byeonheejae/pro/agent-control")).toBe(
      "…/pro/agent-control",
    );
  });

  it("leaves a shallow path whole", () => {
    expect(workspaceLabelFor("/tmp")).toBe("/tmp");
  });

  it("reports nothing for a session with no recorded folder", () => {
    expect(workspaceLabelFor("")).toBe("");
  });
});
