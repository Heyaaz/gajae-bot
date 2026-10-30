import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SystemNoticeActivity } from "../../shared/agent-contract";
import { TranscriptItemView } from "./transcript";

/**
 * The app-owned todo row (`sourceType: "todo.list"`) as the transcript renders it.
 *
 * The statuses below are the runtime's own vocabulary, quoted as the store reports them;
 * the card has to show what it was given, so every case here is about what the raw value
 * said rather than about what a task probably is.
 */
function todoItem(
  overrides: Partial<SystemNoticeActivity>,
): SystemNoticeActivity {
  return {
    id: "app-todo-session-1",
    kind: "system",
    sessionId: "session-1",
    title: "Todos",
    content: "",
    createdAt: "now",
    sourceType: "todo.list",
    ...overrides,
  };
}

function render(item: SystemNoticeActivity): string {
  return renderToStaticMarkup(
    createElement(TranscriptItemView, {
      item,
      onResolveTool: () => undefined,
      onReadArtifact: undefined,
    }),
  );
}

describe("todo snapshot card", () => {
  it("renders a checklist with counts, phase names and notes", () => {
    const markup = render(
      todoItem({
        content: "- source: todo.list (strict read)\n- observed: 04:10",
        todoPhases: [
          {
            name: "준비",
            tasks: [
              { content: "베이스 분리", status: "in_progress" },
              { content: "회귀 테스트", status: "completed" },
            ],
          },
          {
            name: "마무리",
            tasks: [
              { content: "문서 갱신", status: "pending" },
              {
                content: "구형 API 제거",
                status: "abandoned",
                notes: ["이번 릴리스에서 뺐습니다\n다음 릴리스 후보"],
              },
            ],
          },
        ],
      }),
    );

    expect(markup).toContain("in progress 1 · pending 1 · completed 1 · abandoned 1");
    expect(markup).toContain("◐");
    expect(markup).toContain("○");
    expect(markup).toContain("✓");
    expect(markup).toContain("⊘");
    expect(markup).toContain("준비");
    expect(markup).toContain("마무리");
    expect(markup).toContain("todo-task--completed");
    // Only the first line stays on screen; the hover title carries the whole note.
    expect(markup).toMatch(/title="이번 릴리스에서 뺐습니다\s*다음 릴리스 후보"/);
    expect(markup).toContain(">이번 릴리스에서 뺐습니다</span>");
  });

  it("shows only each task's title and keeps its notes folded until it is opened", () => {
    const markup = render(
      todoItem({
        todoPhases: [
          {
            tasks: [
              { content: "채팅 리팩토링", status: "in_progress", notes: ["첫 메모", "둘째 메모", "  "] },
              { content: "메모 없는 작업", status: "pending" },
            ],
          },
        ],
      }),
    );

    expect(markup).toMatch(
      /<details class="todo-task-body"><summary><span class="todo-task-content">채팅 리팩토링<\/span><span class="todo-task-note-count">.*?2<\/span><\/summary>/,
    );
    expect(markup).not.toMatch(/<details[^>]* open/);
    expect(markup).toContain('<div class="todo-task-body"><span class="todo-task-content">메모 없는 작업</span></div>');
  });

  it("shows one dim empty line instead of the snapshot's report", () => {
    // Rendered from a local time so the clock label is the same in every zone.
    const observedAt = new Date(2026, 9, 16, 7, 5).toISOString();
    const markup = render(
      todoItem({
        observedAt,
        content:
          "- source: todo.list (strict read)\n- observed: 07:05\n- records: 0\n```json\n[]\n```",
        todoPhases: [{ name: "1단계", tasks: [] }],
      }),
    );

    expect(markup).toContain("todo-empty");
    expect(markup).toContain("No todos");
    expect(markup).toContain("observed 07:05 · todo.list");
    expect(markup).not.toContain("<li");
    expect(markup).not.toContain("- source: todo.list");
    expect(markup).not.toContain("- 반환된 작업 기록");
    expect(markup).not.toContain("json");
  });

  it("drops an observation time it cannot read", () => {
    const markup = render(
      todoItem({ observedAt: "어제쯤", todoPhases: [] }),
    );

    expect(markup).toContain("No todos");
    expect(markup).not.toContain("observed");
  });

  it("renders an unknown status as its own marker, never as completed", () => {
    const markup = render(
      todoItem({
        todoPhases: [
          { tasks: [{ content: "외부 검토 대기", status: "blocked" }] },
        ],
      }),
    );

    expect(markup).toContain("•");
    expect(markup).toContain("other 1");
    expect(markup).toContain("todo-task--unknown");
    expect(markup).not.toContain("✓");
    expect(markup).not.toContain("completed");
  });

  it("treats a prototype key as an unknown status, not as a known one", () => {
    // Statuses are data, and `"constructor" in {}` is true, so the lookup over the
    // status table cannot be an `in` check.
    const markup = render(
      todoItem({
        todoPhases: [
          { tasks: [{ content: "외부 도구가 쓴 항목", status: "constructor" }] },
        ],
      }),
    );

    expect(markup).toContain("•");
    expect(markup).toContain("other 1");
  });

  it("matches a status the runtime capitalized or padded", () => {
    const markup = render(
      todoItem({
        todoPhases: [
          {
            tasks: [
              { content: "베이스 분리", status: " In_Progress " },
              { content: "회귀 테스트", status: "Completed" },
            ],
          },
        ],
      }),
    );

    expect(markup).toContain("in progress 1 · completed 1");
    expect(markup).toContain("◐");
    expect(markup).toContain("✓");
  });

  it("keeps the earlier system card when the row carries no phases", () => {
    const markup = render(
      todoItem({
        content:
          "- source: todo.list (strict read)\n- observed: 04:10\n- records: 2\n```json\n[]\n```",
      }),
    );

    expect(markup).not.toContain("todo-card");
    expect(markup).not.toContain("런타임 활동");
    expect(markup).toContain("source: todo.list");
    expect(markup).toContain("observed:");
    expect(markup).toContain("더 보기");
  });
});
