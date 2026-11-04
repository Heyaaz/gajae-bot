import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ToolActivity, TranscriptItem } from "../backend/types";
import { Transcript, TranscriptItemView } from "./transcript";
import { ToolCard } from "./transcript-tool-card";

const noop = () => undefined;

function tool(overrides: Partial<ToolActivity>): ToolActivity {
  return {
    id: "call-1",
    kind: "tool",
    sessionId: "session-1",
    name: "bash",
    description: "tool",
    status: "completed",
    createdAt: "now",
    ...overrides,
  };
}

function card(row: ToolActivity): string {
  return renderToStaticMarkup(createElement(ToolCard, { tool: row, onResolve: noop }));
}

const PATCH =
  "*** Begin Patch\n*** Update File: src/calc.js\n@@\n-return a - b;\n+return a + b;\n*** End Patch";
const DIFF = "@@ -1,3 +1,3 @@\n 1|function add(a, b) {\n-2|  return a - b;\n+2|  return a + b;\n 3|}";

describe("tool card default view shows what the tool did, not its JSON", () => {
  it("edit shows the diff and none of the patch or result JSON", () => {
    const markup = card(
      tool({
        name: "edit",
        command: JSON.stringify({ input: PATCH }, null, 2),
        output: `Updated src/calc.js\n\ndetails\n${JSON.stringify({ diff: DIFF, oldText: "a - b", newText: "a + b" }, null, 2)}`,
        diff: DIFF,
      }),
    );
    expect(markup).toContain("return a + b;");
    expect(markup).toContain("src/calc.js");
    expect(markup).not.toContain("Begin Patch");
    expect(markup).not.toContain("oldText");
    expect(markup).not.toContain("&quot;input&quot;");
  });

  it("edit with no diff yet names the file from the patch", () => {
    const markup = card(
      tool({ name: "edit", status: "running", command: JSON.stringify({ input: PATCH }) }),
    );
    expect(markup).toContain("tool-target-path");
    expect(markup).toContain("src/calc.js");
    expect(markup).not.toContain("Begin Patch");
  });

  it("read shows the path, the requested range and the line count, not the file body or JSON", () => {
    const markup = card(
      tool({
        name: "read",
        command: JSON.stringify({ path: "src/app.ts:65-112,160-215" }),
        output: "line one\nline two\nline three",
      }),
    );
    expect(markup).toContain("src/app.ts");
    expect(markup).toContain("65-112,160-215");
    expect(markup).toContain("3줄");
    expect(markup).not.toContain("line two");
    expect(markup).not.toContain("&quot;path&quot;");
  });

  it("read does not claim a line count for a truncated artifact stub", () => {
    const markup = card(
      tool({
        name: "read",
        command: JSON.stringify({ path: "big.log" }),
        output: "[Output truncated - 3209 tokens; full output: artifact://215] first",
      }),
    );
    expect(markup).toContain("big.log");
    expect(markup).not.toMatch(/\d+줄/u);
  });

  it("a failed read still shows why", () => {
    const markup = card(
      tool({
        name: "read",
        status: "failed",
        command: JSON.stringify({ path: "missing.txt" }),
        output: "ENOENT: no such file",
      }),
    );
    expect(markup).toContain("ENOENT: no such file");
  });

  it("write shows the path and how many lines were written", () => {
    const markup = card(
      tool({
        name: "write",
        command: JSON.stringify({ path: "out.txt", content: "a\nb\nc\n" }),
        output: "Wrote out.txt",
      }),
    );
    expect(markup).toContain("out.txt");
    expect(markup).toContain("3줄");
    expect(markup).not.toContain("&quot;content&quot;");
  });

  it("bash shows the command and its output", () => {
    const markup = card(
      tool({
        name: "bash",
        command: JSON.stringify({ command: "npm test", _i: "Running tests" }),
        output: "3 passed",
      }),
    );
    expect(markup).toContain("<code>npm test</code>");
    expect(markup).toContain("3 passed");
    expect(markup).not.toContain("_i");
  });

  it("hides JSON output a person cannot read, for a tool with no summary of its own", () => {
    const markup = card(
      tool({
        name: "custom_tool",
        command: JSON.stringify({ query: "x", limit: 3 }),
        output: JSON.stringify({ total: 3, items: ["a"] }),
      }),
    );
    expect(markup).not.toContain("tool-output-preview");
    expect(markup).not.toContain("&quot;query&quot;");
  });

  it("keeps the proposed change readable while it waits for approval", () => {
    const markup = card(
      tool({
        name: "edit",
        status: "approval-required",
        command: JSON.stringify({ input: PATCH }),
        permissionOptions: [{ optionId: "allow", name: "허용", kind: "allow_once" }],
      }),
    );
    expect(markup).toContain("Begin Patch");
  });

  it("keeps the raw input and output behind 상세 내용 보기", () => {
    const markup = card(
      tool({
        name: "read",
        command: JSON.stringify({ path: "a.ts" }),
        output: "x",
      }),
    );
    expect(markup).toContain("상세 내용 보기");
    expect(markup).not.toContain("tool-full-details");
  });
});

describe("empty session", () => {
  const emptyTodo = {
    id: "todo-1",
    kind: "system",
    sessionId: "session-1",
    sourceType: "todo.list",
    title: "Todos",
    content: "- source: todo.list",
    todoPhases: [],
    createdAt: "now",
  } as unknown as TranscriptItem;

  it("draws no card for an empty todo result and shows example requests instead", () => {
    const markup = renderToStaticMarkup(
      createElement(Transcript, {
        sessionId: "session-1",
        items: [emptyTodo],
        onResolveTool: noop,
        onPickExample: vi.fn(),
      }),
    );
    expect(markup).not.toContain("No todos");
    expect(markup).not.toContain("todo-card");
    expect(markup).toContain("이 프로젝트가 뭘 하는지 설명해 줘");
    expect(markup).toContain("README를 읽기 쉽게 다듬어 줘");
    expect(markup).toContain("테스트를 실행하고 실패한 걸 알려 줘");
  });

  it("still draws a todo snapshot that has tasks", () => {
    const withTask = {
      ...emptyTodo,
      todoPhases: [{ name: "구현", tasks: [{ content: "함수 추가", status: "pending" }] }],
    } as unknown as TranscriptItem;
    const markup = renderToStaticMarkup(
      createElement(TranscriptItemView, {
        item: withTask,
        onResolveTool: noop,
      } as never),
    );
    expect(markup).toContain("함수 추가");
  });
});
