import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentSession, TranscriptItem } from "../backend/types";
import { Inspector, shouldClearCommitMessage } from "./inspector";

function session(): AgentSession {
  return {
    id: "session-1",
    title: "Session",
    subtitle: "",
    workspace: "/tmp/project",
    runtime: "gjc",
    status: "running",
    updatedAt: new Date().toISOString(),
    pinned: false,
    unread: false,
    accent: "#ffffff",
    ownership: "gajae",
    attachment: "attached",
  } as AgentSession;
}

function taskTool(id: string, status: string): TranscriptItem {
  return {
    id,
    sessionId: "session-1",
    kind: "tool",
    name: "task",
    description: "task",
    status,
    createdAt: "now",
    subagents: [],
  } as unknown as TranscriptItem;
}

const noop = () => undefined;

function props(transcript: TranscriptItem[]) {
  return {
    session: session(),
    transcript,
    liveSubagents: [],
    resuming: false,
    onResume: noop,
    onClose: noop,
  } as unknown as Parameters<typeof Inspector>[0];
}

describe("Inspector", () => {
  it("is memoized so a streamed chunk cannot re-render the panel", () => {
    // The panel is a child of the shell, so any state the shell owns -- a streamed
    // chunk, a keystroke in the composer -- re-runs it. It shows a few rows but scans
    // the whole transcript to find them, and on a long session that scan was repeating
    // for updates that could not change it. React only skips that for a memo
    // component, so the wrapper is the fix and has to be asserted: exporting the bare
    // function would silently undo it.
    const marker = (Inspector as unknown as { $$typeof: symbol }).$$typeof;
    expect(String(marker)).toBe("Symbol(react.memo)");
  });

  it("still lists the subagents the transcript declares", () => {
    // Guards the wrapper against being satisfied by something that renders nothing.
    const markup = renderToStaticMarkup(
      createElement(Inspector, props([taskTool("call-1", "running")])),
    );
    expect(markup).toContain("subagent-card");
    expect(markup).not.toContain("실행된 서브 에이전트가 없습니다");
  });

  it("says so when no subagent ran", () => {
    const markup = renderToStaticMarkup(createElement(Inspector, props([])));
    expect(markup).toContain("실행된 서브 에이전트가 없습니다");
  });

  it("offers native expandable details and keeps shell results after completion", () => {
    const tool = { ...taskTool("shell-1", "completed"), name: "bash", output: "finished output" } as TranscriptItem;
    const markup = renderToStaticMarkup(createElement(Inspector, props([tool])));
    expect(markup).toContain("<details");
    expect(markup).toContain("finished output");
    expect(markup).toContain("완료");
  });

  it("does not mark a queued task complete", () => {
    const markup = renderToStaticMarkup(createElement(Inspector, props([taskTool("queued", "pending")])));
    expect(markup).toContain("subagent-card--waiting");
  });

  it("clears a commit message only after success and only if it was not edited", () => {
    const submittedRevision = 3;

    // A rejected backend mutation is reported by mutate as unsuccessful, so its
    // typed message stays available alongside the error.
    expect(shouldClearCommitMessage(false, submittedRevision, submittedRevision)).toBe(
      false,
    );

    expect(shouldClearCommitMessage(true, submittedRevision, submittedRevision)).toBe(
      true,
    );
    expect(shouldClearCommitMessage(true, submittedRevision, submittedRevision + 1)).toBe(
      false,
    );
  });
});
