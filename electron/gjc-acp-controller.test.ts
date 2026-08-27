import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  brokerFailureMessage,
  busyPromptError,
  cancelledOperationError,
  configuredProfileDefaultThinking,
  gitBranchFromHeader,
  inferToolName,
  isControllerSession,
  lastReportedModel,
  messageTextWithFiles,
  persistedModelState,
  persistedTranscriptRunning,
  profileDefaultModelLabel,
  readableModelLabel,
  sessionInfoToAgentSession,
  sharedTranscriptItems,
  taskSubagents,
  thinkingOptionsForModelCatalog,
  toolDiffText,
  toolImageRefs,
  uncertainAfterSendError,
} from "./gjc-acp-controller.js";
import { GjcAcpController } from "./gjc-acp-controller.js";
import type { AgentEvent, TranscriptItem } from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";

const execFile = promisify(execFileCallback);

describe("gitBranchFromHeader", () => {
  it("reads the branch of a repository whose first commit does not exist yet", () => {
    expect(gitBranchFromHeader("No commits yet on main")).toBe("main");
  });

  it("reads a tracking branch and a detached head", () => {
    expect(gitBranchFromHeader("feature/x")).toBe("feature/x");
    expect(gitBranchFromHeader("HEAD (no branch)")).toBe("HEAD");
  });
});

describe("lastReportedModel", () => {
  it("reports the model of the most recent assistant turn", () => {
    expect(
      lastReportedModel([
        { role: "assistant", model: "gpt-5.6-sol" },
        { role: "toolResult" },
        { role: "assistant", model: "claude-opus-5" },
        { role: "user" },
      ]),
    ).toBe("claude-opus-5");
  });

  it("returns nothing when no assistant turn states a model", () => {
    expect(
      lastReportedModel([{ role: "user" }, { role: "assistant" }]),
    ).toBeUndefined();
  });
});

describe("persistedTranscriptRunning", () => {
  it("stays active after a user turn until an assistant stop record", () => {
    expect(
      persistedTranscriptRunning([
        { type: "message", message: { role: "assistant", stopReason: "stop" } },
        { type: "message", message: { role: "user" } },
        {
          type: "message",
          message: { role: "assistant", stopReason: "toolUse" },
        },
        { type: "message", message: { role: "toolResult" } },
      ]),
    ).toBe(true);
  });

  it("becomes idle only when the current turn has an assistant stop record", () => {
    expect(
      persistedTranscriptRunning([
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant", stopReason: "stop" } },
      ]),
    ).toBe(false);
  });

  it("treats an aborted assistant turn as idle", () => {
    expect(
      persistedTranscriptRunning([
        { type: "message", message: { role: "user" } },
        {
          type: "message",
          message: { role: "assistant", stopReason: "aborted" },
        },
      ]),
    ).toBe(false);
  });
  it("does not treat later aborted-turn tool leftovers as a live run", () => {
    expect(
      persistedTranscriptRunning([
        { type: "message", message: { role: "user" } },
        {
          type: "message",
          message: { role: "assistant", stopReason: "aborted" },
        },
        {
          type: "message",
          message: { role: "assistant", stopReason: "toolUse" },
        },
        { type: "message", message: { role: "toolResult" } },
      ]),
    ).toBe(false);
  });
});

describe("persistedModelState", () => {
  it("uses the latest profile default unless a later operator effort overrides it", () => {
    expect(
      persistedModelState([
        {
          type: "thinking_level_change",
          thinkingLevel: "off",
          operatorIntent: true,
        },
        {
          type: "configured_model_chain",
          role: "default",
          identity: "GOAT",
          entries: ["codex-lb/gpt-5.6-sol:medium"],
        },
      ]),
    ).toEqual({ model: "GOAT", thinking: "medium" });
    expect(
      persistedModelState([
        {
          type: "configured_model_chain",
          role: "default",
          identity: "GOAT",
          entries: ["codex-lb/gpt-5.6-sol:medium"],
        },
        {
          type: "thinking_level_change",
          thinkingLevel: "high",
          operatorIntent: true,
        },
      ]),
    ).toEqual({ model: "GOAT", thinking: "high" });
  });
});

describe("readableModelLabel", () => {
  it("shows the actual provider model instead of the preset id", () => {
    expect(readableModelLabel("codex-lb/gpt-5.6-sol")).toBe("GPT-5.6 Sol");
  });
});

describe("configuredProfileDefaultThinking", () => {
  it("uses the selected custom profile default effort", () => {
    expect(
      configuredProfileDefaultThinking(
        `profiles:\n  GOAT:\n    model_mapping:\n      default: codex-lb/gpt-5.6-sol:medium\n      planner: codex-lb/gpt-5.6-terra:xhigh\n  other:\n    model_mapping:\n      default: provider/model:low\n`,
        "GOAT",
      ),
    ).toBe("medium");
  });
});

describe("brokerFailureMessage", () => {
  it("extracts the SDK error instead of exposing an execFile command failure", () => {
    expect(
      brokerFailureMessage({
        message: "Command failed",
        stdout: JSON.stringify({
          ok: false,
          error: {
            code: "busy",
            message:
              "turn.prompt is unavailable while the agent is busy; use turn.steer explicitly.",
          },
        }),
      }),
    ).toBe(
      "turn.prompt is unavailable while the agent is busy; use turn.steer explicitly.",
    );
  });
});

describe("sharedTranscriptItems", () => {
  it("projects terminal-owned messages and tool results into desktop transcript items", () => {
    const items = sharedTranscriptItems("shared-session", [
      {
        id: "user-1",
        role: "user",
        ts: "2026-08-25T23:00:00.000Z",
        body: "Inspect this repository",
        content: [{ type: "text", text: "Inspect this repository" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        ts: "2026-08-25T23:00:01.000Z",
        content: [
          { type: "thinking", thinking: "Checking files" },
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
      },
      {
        id: "result-1",
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        body: "Project readme",
      },
      {
        id: "assistant-2",
        role: "assistant",
        ts: "2026-08-25T23:00:02.000Z",
        body: "Done",
        content: [{ type: "text", text: "Done" }],
      },
    ]);

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          role: "user",
          content: "Inspect this repository",
        }),
        expect.objectContaining({
          kind: "thought",
          content: "Checking files",
          streaming: false,
        }),
        expect.objectContaining({
          id: "call-1",
          kind: "tool",
          name: "read",
          status: "completed",
          output: "Project readme",
        }),
        expect.objectContaining({
          kind: "message",
          role: "assistant",
          content: "Done",
        }),
      ]),
    );
  });
  it("keeps thinking ahead of the assistant reply instead of after it", () => {
    expect(
      sharedTranscriptItems("shared-session", [
        {
          id: "assistant-mixed",
          role: "assistant",
          ts: "2026-08-26T23:10:00.000Z",
          content: [
            { type: "thinking", thinking: "The user asked about two things:" },
            { type: "text", text: "원인은 두 개였습니다." },
          ],
        },
      ]).map((item) => item.kind),
    ).toEqual(["thought", "message"]);
  });

  it("shows an aborted external turn as an explicit Korean cancellation notice", () => {
    expect(
      sharedTranscriptItems("shared-session", [
        {
          id: "assistant-aborted",
          role: "assistant",
          ts: "2026-08-26T04:57:28.910Z",
          content: [],
          stopReason: "aborted",
          errorMessage: "Request was aborted",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: "notice",
        title: "작업 취소됨",
        content: "진행 중인 작업이 취소되어 종료됐습니다.",
        tone: "neutral",
      }),
    ]);
  });
  it("marks leftover tools from an aborted turn as cancelled instead of running", () => {
    expect(
      sharedTranscriptItems("shared-session", [
        { id: "user-1", role: "user", content: [{ type: "text", text: "go" }] },
        {
          id: "assistant-aborted",
          role: "assistant",
          stopReason: "aborted",
          content: [
            {
              type: "toolCall",
              id: "call-open",
              name: "bash",
              arguments: { command: "sleep 30" },
            },
          ],
        },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "call-open",
          kind: "tool",
          status: "cancelled",
        }),
      ]),
    );
  });
  it("projects GJC compaction entries into desktop compaction cards", () => {
    expect(
      sharedTranscriptItems("shared-session", [
        {
          type: "compaction",
          id: "d1130027",
          timestamp: "2026-08-26T23:00:00.000Z",
          summary: "## Goal\n- Keep transcript sync close to realtime.",
          shortSummary: "Electron 앱과 GJC CLI 간 transcript 동기화",
          tokensBefore: 195276,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "shared-compaction-d1130027",
        kind: "compaction",
        tokensBefore: 195276,
        summary: "## Goal\n- Keep transcript sync close to realtime.",
        shortSummary: "Electron 앱과 GJC CLI 간 transcript 동기화",
      }),
    ]);
  });
  it("projects branch summaries and visible custom messages into desktop cards", () => {
    expect(
      sharedTranscriptItems("shared-session", [
        {
          type: "branch_summary",
          id: "branch-1",
          timestamp: "2026-08-26T23:01:00.000Z",
          summary: "Abandoned branch context",
        },
        {
          type: "custom_message",
          id: "async-1",
          timestamp: "2026-08-26T23:02:00.000Z",
          customType: "async-result",
          display: true,
          content: "3 background jobs have completed.",
        },
        {
          type: "custom_message",
          id: "hidden-1",
          customType: "hidden",
          display: false,
          content: "should not render",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "shared-branch-branch-1",
        kind: "branch_summary",
        summary: "Abandoned branch context",
      }),
      expect.objectContaining({
        id: "shared-system-async-1",
        kind: "system",
        title: "백그라운드 작업 완료",
        content: "3 background jobs have completed.",
      }),
    ]);
  });

  it("shows a terminal provider failure as a Korean error notice with the provider message", () => {
    expect(
      sharedTranscriptItems("shared-session", [
        {
          id: "assistant-error",
          role: "assistant",
          ts: "2026-08-26T06:08:45.180Z",
          content: [],
          stopReason: "error",
          errorMessage: "Provider returned error",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: "notice",
        title: "작업 실패",
        content: "Provider returned error",
        tone: "warning",
      }),
    ]);
  });
});

describe("toolDiffText", () => {
  it("finds the unified diff a tool result parked under details", () => {
    expect(toolDiffText({ details: { diff: "@@ -1 +1 @@" } })).toBe(
      "@@ -1 +1 @@",
    );
  });

  it("ignores tool results that carry no diff", () => {
    expect(
      toolDiffText({ details: { meta: {} } }, "plain output"),
    ).toBeUndefined();
  });
});

describe("messageTextWithFiles", () => {
  it("references local files without embedding their contents", () => {
    expect(
      messageTextWithFiles({
        text: "검토해줘",
        images: [],
        files: [
          {
            id: "file-1",
            name: "notes.txt",
            mimeType: "text/plain",
            size: 5,
            path: "/tmp/project/notes.txt",
          },
        ],
      }),
    ).toBe(
      '검토해줘\n\n<local-files>\n- "/tmp/project/notes.txt"\n</local-files>\nUse the read tool on these local files when their contents are needed.',
    );
  });

  it("references images by path instead of uploading image bytes", () => {
    expect(
      messageTextWithFiles({
        text: "이 이미지 확인",
        images: [
          {
            id: "image-1",
            name: "screen.png",
            mimeType: "image/png",
            path: "/tmp/screen.png",
            data: "aW1hZ2U=",
          },
        ],
        files: [],
      }),
    ).toBe(
      '이 이미지 확인\n\n<local-images>\n- "/tmp/screen.png"\n</local-images>\nThe user attached these images. You MUST inspect every image with the read tool before responding.',
    );
  });
});

describe("cancelledOperationError", () => {
  it("recognizes runtime abort variants without treating ordinary failures as cancellation", () => {
    expect(cancelledOperationError(new Error("Operation aborted"))).toBe(true);
    expect(
      cancelledOperationError(
        new DOMException("The operation was aborted", "AbortError"),
      ),
    ).toBe(true);
    expect(cancelledOperationError(new Error("Network request failed"))).toBe(
      false,
    );
  });
});

describe("toolImageRefs", () => {
  it("resolves a content-addressed image into a blob reference", () => {
    expect(
      toolImageRefs([
        {
          type: "image",
          mimeType: "image/webp",
          data: `blob:sha256:${"a".repeat(64)}`,
        },
      ]),
    ).toEqual([
      { mimeType: "image/webp", dataUrl: "", blobId: "a".repeat(64) },
    ]);
  });

  it("inlines an image that already arrived as base64", () => {
    expect(
      toolImageRefs([{ type: "image", mimeType: "image/png", data: "AAAA" }]),
    ).toEqual([
      { mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
    ]);
  });
});

describe("taskSubagents", () => {
  it("projects each delegated task with its role, purpose, and individual receipt status", () => {
    expect(
      taskSubagents(
        {
          agent: "architect",
          tasks: [
            {
              id: "CursorUX",
              description: "Cursor UX research",
              assignment:
                "# Target\nResearch Cursor agent navigation.\n# Acceptance\nReport findings.",
            },
          ],
        },
        "completed",
        '<agent id="CursorUX"><status>failed</status></agent>',
      ),
    ).toEqual([
      {
        id: "CursorUX",
        label: "Cursor UX research",
        role: "architect",
        objective: "Research Cursor agent navigation.",
        status: "failed",
      },
    ]);
  });
});

describe("sessionInfoToAgentSession", () => {
  it("projects ACP metadata into the runtime-neutral session contract", () => {
    const session = sessionInfoToAgentSession({
      sessionId: "f6ae5c39-46e7-4dad-9649-f6ffc2e68a28",
      cwd: "/Users/example/project",
      title: "Fix authentication retry",
      updatedAt: new Date().toISOString(),
    });

    expect(session).toMatchObject({
      id: "f6ae5c39-46e7-4dad-9649-f6ffc2e68a28",
      title: "Fix authentication retry",
      subtitle: "project",
      workspace: "/Users/example/project",
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
    });
  });

  it("replaces opaque broker titles with a readable short session label", () => {
    const session = sessionInfoToAgentSession({
      sessionId: "f6ae5c39-46e7-4dad-9649-f6ffc2e68a28",
      cwd: "/Users/example/project",
      title: "f6ae5c39-46e7-4dad-9649-f6ffc2e68a28",
    });

    expect(session.title).toBe("GJC session · f6ae5c39");
  });

  it("coalesces streamed assistant chunks into one transcript message", () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const handleSessionUpdate = (
      controller as unknown as {
        handleSessionUpdate(notification: SessionNotification): void;
      }
    ).handleSessionUpdate.bind(controller);

    handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "chunk-1",
        content: { type: "text", text: "How " },
      },
    });
    handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "chunk-2",
        content: { type: "text", text: "are you?" },
      },
    });

    const appended = events.filter(
      (event) => event.type === "transcript.appended",
    );
    const deltas = events.filter((event) => event.type === "message.delta");
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      item: { kind: "message", role: "assistant", content: "How " },
    });
    expect(deltas).toEqual([
      expect.objectContaining({ type: "message.delta", delta: "are you?" }),
    ]);
    controller.dispose();
  });

  it("projects ACP image chunks into visible message attachments", () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const handleSessionUpdate = (
      controller as unknown as {
        handleSessionUpdate(notification: SessionNotification): void;
      }
    ).handleSessionUpdate.bind(controller);

    handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "message-with-image",
        content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "transcript.appended",
        item: expect.objectContaining({
          kind: "message",
          role: "user",
          images: [
            expect.objectContaining({
              mimeType: "image/png",
              data: "aW1hZ2U=",
            }),
          ],
        }),
      }),
    );
    controller.dispose();
  });

  it("sends text and image blocks through the ACP prompt", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; prompt: typeof prompt };
      attachedSessions: Set<string>;
      sessions: Map<string, unknown>;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, prompt };
    internals.attachedSessions.add("session-1");
    internals.sessions.set("session-1", {
      id: "session-1",
      title: "Image session",
      subtitle: "project",
      workspace: "/tmp/project",
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      pinned: false,
      unread: false,
      accent: "#ff8a34",
    });

    await controller.sendMessage("session-1", {
      text: "Inspect this",
      images: [
        {
          id: "image-1",
          name: "screen.png",
          mimeType: "image/png",
          path: "/tmp/screen.png",
          data: "aW1hZ2U=",
        },
      ],
      files: [],
    });

    expect(prompt).toHaveBeenCalledWith({
      sessionId: "session-1",
      prompt: [
        { type: "text", text: expect.stringContaining('- "/tmp/screen.png"') },
      ],
    });
    controller.dispose();
  });

  it("emits one activity notification after the turn instead of per tool", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        prompt: (input: unknown) => Promise<{ stopReason: string }>;
        extMethod: () => Promise<unknown>;
      };
      attachedSessions: Set<string>;
      sessions: Map<string, unknown>;
      handleSessionUpdate(notification: SessionNotification): void;
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod: () => Promise.resolve({ page: { items: [] } }),
      prompt: async () => {
        internals.handleSessionUpdate({
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "bash-1",
            title: "First Bash",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "false" },
          },
        });
        internals.handleSessionUpdate({
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "bash-1",
            status: "failed",
            rawOutput: "exit 1",
          },
        });
        internals.handleSessionUpdate({
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "bash-2",
            title: "Second Bash",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "true" },
          },
        });
        internals.handleSessionUpdate({
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "bash-2",
            status: "completed",
            rawOutput: "",
          },
        });
        return { stopReason: "end_turn" };
      },
    };
    internals.attachedSessions.add("session-1");
    internals.sessions.set("session-1", {
      id: "session-1",
      title: "Notification session",
      subtitle: "project",
      workspace: "/tmp/project",
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      pinned: false,
      unread: false,
      accent: "#ff8a34",
    });

    await controller.sendMessage("session-1", {
      text: "Run both checks",
      images: [],
      files: [],
    });

    expect(events.filter((event) => event.type === "session.activity")).toEqual(
      [
        {
          type: "session.activity",
          sessionId: "session-1",
          unread: true,
          category: "completed",
        },
      ],
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.updated",
        tool: expect.objectContaining({ id: "bash-1", status: "failed" }),
      }),
    );
    controller.dispose();
  });

  it("queries context usage after a prompt when GJC omits the ACP usage update", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    const extMethod = vi.fn().mockResolvedValue({
      page: {
        items: [
          {
            usage: {
              tokens: 93_000,
              contextWindow: 372_000,
              percent: 25,
              source: "provider_anchor",
            },
          },
        ],
      },
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        prompt: typeof prompt;
        extMethod: typeof extMethod;
      };
      attachedSessions: Set<string>;
      sessions: Map<string, unknown>;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, prompt, extMethod };
    internals.attachedSessions.add("session-1");
    internals.sessions.set("session-1", {
      id: "session-1",
      title: "Usage session",
      subtitle: "project",
      workspace: "/tmp/project",
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      pinned: false,
      unread: false,
      accent: "#ff8a34",
    });

    await controller.sendMessage("session-1", {
      text: "Hello",
      images: [],
      files: [],
    });

    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/query", {
      sessionId: "session-1",
      query: "context.get",
      input: {},
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.updated",
        session: expect.objectContaining({ id: "session-1", usagePercent: 25 }),
      }),
    );
    controller.dispose();
  });

  it("projects thoughts, plans, commands, and session configuration", () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const handleSessionUpdate = (
      controller as unknown as {
        handleSessionUpdate(notification: SessionNotification): void;
      }
    ).handleSessionUpdate.bind(controller);

    handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "Planning " },
      },
    });
    handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "the change" },
      },
    });
    handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          {
            content: "Implement bridge",
            priority: "high",
            status: "in_progress",
          },
        ],
      },
    });
    handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "skill:ralplan",
            description: "Plan changes",
            input: { hint: "[request]" },
          },
        ],
      },
    });
    handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            type: "select",
            id: "model",
            name: "Preset",
            category: "model",
            currentValue: "codex-pro",
            options: [{ value: "codex-pro", name: "Codex Pro" }],
          },
        ],
      },
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "transcript.appended",
          item: expect.objectContaining({
            kind: "thought",
            content: "Planning ",
          }),
        }),
        expect.objectContaining({ type: "thought.delta", delta: "the change" }),
        expect.objectContaining({
          type: "plan.updated",
          plan: expect.objectContaining({
            entries: [expect.objectContaining({ content: "Implement bridge" })],
          }),
        }),
        {
          type: "session.commands",
          sessionId: "session-1",
          commands: [
            {
              name: "skill:ralplan",
              description: "Plan changes",
              hint: "[request]",
            },
          ],
        },
        expect.objectContaining({
          type: "session.config",
          sessionId: "session-1",
          options: [
            expect.objectContaining({ id: "model", currentValue: "codex-pro" }),
          ],
        }),
      ]),
    );
    controller.dispose();
  });

  it("keeps thoughts before and after a tool call as separate visible steps", () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const handleSessionUpdate = (
      controller as unknown as {
        handleSessionUpdate(notification: SessionNotification): void;
      }
    ).handleSessionUpdate.bind(controller);

    handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "Verifying process visibility" },
      },
    });
    handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Bash",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "pgrep -x Gajae" },
      },
    });
    handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-2",
        content: { type: "text", text: "Improving window detection" },
      },
    });

    const appended = events
      .filter(
        (
          event,
        ): event is Extract<AgentEvent, { type: "transcript.appended" }> =>
          event.type === "transcript.appended",
      )
      .map((event) => event.item);
    expect(appended.map((item) => item.kind)).toEqual([
      "thought",
      "tool",
      "thought",
    ]);
    expect(appended.filter((item) => item.kind === "thought")).toEqual([
      expect.objectContaining({
        content: "Verifying process visibility",
        streaming: true,
      }),
      expect.objectContaining({
        content: "Improving window detection",
        streaming: true,
      }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thought.delta",
        thoughtId: "acp-thought-thought-1",
        streaming: false,
      }),
    );
    controller.dispose();
  });

  it("hides a missing saved session instead of surfacing repeated delete errors", async () => {
    const events: AgentEvent[] = [];
    const hideSession = vi.fn();
    const deleteAlias = vi.fn();
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
      sessionMetadata: {
        hideSession,
        deleteAlias,
      } as unknown as SessionMetadataStore,
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        deleteSession: () => Promise<never>;
      };
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      deleteSession: () =>
        Promise.reject(
          new Error("Saved ACP session does not exist: stale-session"),
        ),
    };

    await expect(
      controller.deleteSession("stale-session"),
    ).resolves.toBeUndefined();
    expect(hideSession).not.toHaveBeenCalled();
    expect(deleteAlias).toHaveBeenCalledWith("stale-session");
    expect(events).toContainEqual({
      type: "session.deleted",
      sessionId: "stale-session",
    });
    controller.dispose();
  });

  it("shows a reconciliation notice instead of throwing for uncertain lifecycle evidence", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const session = {
      ...sessionInfoToAgentSession({
        sessionId: "uncertain-session",
        cwd: "/tmp/project",
      }),
      ownership: "gajae" as const,
    };
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        loadSession: () => Promise<never>;
      };
      sessions: Map<string, typeof session>;
      sessionCwds: Map<string, string>;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(session.id, session);
    internals.sessionCwds.set(session.id, session.workspace);
    internals.connection = {
      signal: { aborted: false },
      loadSession: () =>
        Promise.reject(
          new Error(
            "Lifecycle terminal evidence could not be verified after persistence; retained artifacts require reconciliation.",
          ),
        ),
    };

    await expect(controller.getTranscript(session.id)).resolves.toEqual([
      expect.objectContaining({
        kind: "notice",
        title: "저장된 세션을 검증할 수 없습니다",
        tone: "warning",
      }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.updated",
        session: expect.objectContaining({
          id: session.id,
          attachment: "recovering",
          status: "failed",
        }),
      }),
    );
    controller.dispose();
  });

  it("permanently deletes external sessions through broker lifecycle authority", async () => {
    const events: AgentEvent[] = [];
    const deleteAlias = vi.fn();
    const brokerLifecycleDelete = vi.fn().mockResolvedValue(undefined);
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
      sessionMetadata: { deleteAlias } as unknown as SessionMetadataStore,
    });
    const session = sessionInfoToAgentSession({
      sessionId: "external-session",
      cwd: "/tmp/project",
    });
    const internals = controller as unknown as {
      sessions: Map<string, typeof session>;
      brokerLifecycleDelete: typeof brokerLifecycleDelete;
    };
    internals.sessions.set(session.id, session);
    internals.brokerLifecycleDelete = brokerLifecycleDelete;

    await expect(controller.deleteSession(session.id)).resolves.toBeUndefined();
    expect(brokerLifecycleDelete).toHaveBeenCalledWith(session.id);
    expect(deleteAlias).toHaveBeenCalledWith(session.id);
    expect(events).toContainEqual({
      type: "session.deleted",
      sessionId: session.id,
    });
    controller.dispose();
  });

  it("removes dead uncertain session files when GJC refuses official deletion", async () => {
    const events: AgentEvent[] = [];
    const deleteAlias = vi.fn();
    const root = await mkdtemp(path.join(tmpdir(), "gajae-delete-"));
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const sessionPath = path.join(
      root,
      `2026-08-26T00-00-00-000Z_${sessionId}.jsonl`,
    );
    const artifactsPath = sessionPath.slice(0, -".jsonl".length);
    await writeFile(sessionPath, "{}\n");
    await mkdir(artifactsPath);
    await writeFile(path.join(artifactsPath, "note.txt"), "kept-by-gjc");
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
      sessionMetadata: { deleteAlias } as unknown as SessionMetadataStore,
    });
    const session = sessionInfoToAgentSession({
      sessionId,
      cwd: "/tmp/project",
    });
    const internals = controller as unknown as {
      sessions: Map<string, typeof session>;
      brokerLifecycle: (
        operation: string,
        input: Record<string, unknown>,
      ) => Promise<void>;
      locateSharedTranscriptFile: (id: string) => Promise<string | undefined>;
      sessionIsLive: (id: string) => Promise<boolean>;
    };
    internals.sessions.set(session.id, session);
    internals.sessionIsLive = async () => false;
    internals.locateSharedTranscriptFile = async () => sessionPath;
    internals.brokerLifecycle = async () => {
      throw new Error(
        "Lifecycle terminal evidence could not be verified after persistence; retained artifacts require reconciliation.",
      );
    };

    await expect(controller.deleteSession(session.id)).resolves.toBeUndefined();
    await expect(rm(sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(rm(artifactsPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(deleteAlias).toHaveBeenCalledWith(session.id);
    expect(events).toContainEqual({
      type: "session.deleted",
      sessionId: session.id,
    });
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("closes then deletes owned sessions when ACP deletion is uncertain", async () => {
    const events: AgentEvent[] = [];
    const deleteAlias = vi.fn();
    const hideSession = vi.fn();
    const brokerLifecycleDelete = vi.fn().mockResolvedValue(undefined);
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
      sessionMetadata: {
        deleteAlias,
        hideSession,
      } as unknown as SessionMetadataStore,
    });
    const session = {
      ...sessionInfoToAgentSession({
        sessionId: "owned-session",
        cwd: "/tmp/project",
      }),
      ownership: "gajae" as const,
    };
    const internals = controller as unknown as {
      startup: Promise<void>;
      sessions: Map<string, typeof session>;
      connection: {
        signal: { aborted: boolean };
        deleteSession: () => Promise<never>;
      };
      brokerLifecycleDelete: typeof brokerLifecycleDelete;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(session.id, session);
    internals.connection = {
      signal: { aborted: false },
      deleteSession: () =>
        Promise.reject(
          new Error(
            "terminal_uncertain: retained artifacts require reconciliation",
          ),
        ),
    };
    internals.brokerLifecycleDelete = brokerLifecycleDelete;

    await expect(controller.deleteSession(session.id)).resolves.toBeUndefined();
    expect(brokerLifecycleDelete).toHaveBeenCalledWith(session.id);
    expect(internals.sessions.has(session.id)).toBe(false);
    expect(deleteAlias).toHaveBeenCalledWith(session.id);
    expect(hideSession).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "session.deleted",
      sessionId: session.id,
    });
    controller.dispose();
  });

  it("merges configured and built-in profiles into classified model groups", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: (
          _method: string,
          params: { query: string },
        ) => Promise<unknown>;
      };
      sessions: Map<string, ReturnType<typeof sessionInfoToAgentSession>>;
      handleSessionUpdate(notification: SessionNotification): void;
      refreshModelProfiles(sessionId: string): Promise<void>;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(
      "session-1",
      sessionInfoToAgentSession({
        sessionId: "session-1",
        cwd: "/tmp/project",
      }),
    );
    internals.connection = {
      signal: { aborted: false },
      extMethod: (_method, params) =>
        Promise.resolve(
          params.query === "models.list/current"
            ? {
                page: {
                  complete: true,
                  items: [
                    {
                      provider: "gajae-code",
                      id: "GOAT",
                      current: true,
                      profileDefaultModel: {
                        provider: "codex-lb",
                        id: "gpt-5.6-sol",
                        name: "GPT-5.6 Sol",
                      },
                      thinking: {
                        validLevels: ["off", "low", "medium", "high", "xhigh"],
                      },
                    },
                  ],
                },
              }
            : {
                page: {
                  items: [
                    {
                      id: "GOAT",
                      displayName: "GOAT",
                      source: "configured",
                      available: true,
                    },
                    {
                      id: "codex-medium",
                      displayName: "Codex Medium",
                      source: "builtin",
                      available: true,
                    },
                  ],
                },
              },
        ),
    };
    internals.handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            type: "select",
            id: "model",
            name: "Preset",
            category: "model",
            currentValue: "GOAT",
            options: [{ value: "GOAT", name: "GOAT" }],
          },
          {
            type: "select",
            id: "thinking",
            name: "Thinking",
            category: "thought_level",
            currentValue: "high",
            options: [{ value: "max", name: "max" }],
          },
        ],
      },
    });

    await internals.refreshModelProfiles("session-1");

    expect(events.at(-1)).toMatchObject({
      type: "session.config",
      options: [
        expect.objectContaining({
          id: "model",
          options: [
            expect.objectContaining({
              value: "GOAT",
              group: "Custom profiles",
            }),
            expect.objectContaining({
              value: "codex-medium",
              group: "Built-in profiles",
            }),
          ],
        }),
        expect.objectContaining({
          id: "thinking",
          options: [
            { value: "off", name: "off" },
            { value: "low", name: "low" },
            { value: "medium", name: "medium" },
            { value: "high", name: "high" },
            { value: "xhigh", name: "xhigh" },
          ],
        }),
      ],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.updated",
        session: expect.objectContaining({ modelDisplay: "GPT-5.6 Sol" }),
      }),
    );
    controller.dispose();
  });

  it("sets thinking through the SDK control surface instead of ACP session config", async () => {
    const extMethod = vi.fn().mockResolvedValue({ ok: true });
    const setSessionConfigOption = vi.fn();
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        setSessionConfigOption: typeof setSessionConfigOption;
      };
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      setSessionConfigOption,
    };

    await controller.setSessionConfig("ghostty-session", "thinking", "high");

    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: "ghostty-session",
      operation: "thinking.set",
      input: { level: "high" },
    });
    expect(setSessionConfigOption).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("switches model profiles through the SDK control surface", async () => {
    const extMethod = vi.fn().mockResolvedValue({ ok: true });
    const setSessionConfigOption = vi.fn();
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        setSessionConfigOption: typeof setSessionConfigOption;
      };
      sessions: Map<string, ReturnType<typeof sessionInfoToAgentSession>>;
      refreshSessionSettings: (sessionId: string) => Promise<void>;
      refreshModelProfiles: (sessionId: string) => Promise<void>;
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      setSessionConfigOption,
    };
    internals.sessions.set(
      "session-1",
      sessionInfoToAgentSession({
        sessionId: "session-1",
        cwd: "/tmp/project",
      }),
    );
    internals.refreshSessionSettings = vi.fn().mockResolvedValue(undefined);
    internals.refreshModelProfiles = vi.fn().mockResolvedValue(undefined);

    await controller.setSessionConfig("session-1", "model", "GOAT");

    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: "session-1",
      operation: "model.profile.set",
      input: { id: "GOAT" },
    });
    expect(setSessionConfigOption).not.toHaveBeenCalled();
    expect(internals.sessions.get("session-1")?.model).toBe("GOAT");
    expect(internals.sessions.get("session-1")?.modelDisplay).toBe("GOAT");
    controller.dispose();
  });
  it("cycles thinking through the current model's SDK surface", async () => {
    const extMethod = vi.fn().mockResolvedValue({ level: "medium" });
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
      sessions: Map<string, ReturnType<typeof sessionInfoToAgentSession>>;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, extMethod };
    internals.sessions.set(
      "session-1",
      sessionInfoToAgentSession({
        sessionId: "session-1",
        cwd: "/tmp/project",
      }),
    );

    await expect(controller.cycleThinking("session-1")).resolves.toBe("medium");
    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: "session-1",
      operation: "thinking.cycle",
      input: {},
    });
    expect(internals.sessions.get("session-1")?.thinking).toBe("medium");
    controller.dispose();
  });

  it("preserves the resolved model label when only effort changes", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const session = {
      ...sessionInfoToAgentSession({
        sessionId: "session-1",
        cwd: "/tmp/project",
      }),
      model: "GOAT",
      modelDisplay: "GPT-5.6 Sol",
      thinking: "high",
    };
    const setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "GOAT",
          options: [],
        },
        {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "xhigh",
          options: [],
        },
      ],
    });
    const extMethod = vi.fn().mockResolvedValue({ ok: true });
    const internals = controller as unknown as {
      startup: Promise<void>;
      sessions: Map<string, ReturnType<typeof sessionInfoToAgentSession>>;
      attachedSessions: Set<string>;
      connection: {
        signal: { aborted: boolean };
        setSessionConfigOption: typeof setSessionConfigOption;
        extMethod: typeof extMethod;
      };
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(session.id, session);
    internals.attachedSessions.add(session.id);
    internals.connection = {
      signal: { aborted: false },
      setSessionConfigOption,
      extMethod,
    };

    await controller.setSessionConfig(session.id, "thinking", "xhigh");

    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: session.id,
      operation: "thinking.set",
      input: { level: "xhigh" },
    });
    expect(setSessionConfigOption).not.toHaveBeenCalled();
    expect(internals.sessions.get(session.id)).toMatchObject({
      model: "GOAT",
      modelDisplay: "GPT-5.6 Sol",
      thinking: "xhigh",
    });
    controller.dispose();
  });

  it("reconnects only the GJC runtime when global runtime settings change", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      modelPreset: "GOAT",
      permissionHandling: "prompt",
      emit: () => undefined,
    });
    const kill = vi.fn();
    const internals = controller as unknown as {
      child: { kill: typeof kill } | undefined;
      ensureStarted(): Promise<void>;
      modelPreset: string;
      permissionHandling: string;
    };
    internals.child = { kill };
    vi.spyOn(internals, "ensureStarted").mockResolvedValue();

    await expect(
      controller.reconfigure({
        workspace: "/tmp/project",
        workspaceLabel: "개인 Workspace",
        modelPreset: "codex-medium",
        permissionHandling: "auto",
        gjcExecutable: "",
      }),
    ).resolves.toBe(true);

    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(internals.modelPreset).toBe("codex-medium");
    expect(internals.permissionHandling).toBe("auto");
    controller.dispose();
  });

  it("runs manual compaction through the typed SDK control surface", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const extMethod = vi.fn().mockResolvedValue({ ok: true });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
      attachedSessions: Set<string>;
      activePromptSessions: Set<string>;
    };
    internals.startup = Promise.resolve();
    internals.attachedSessions.add("session-1");
    internals.activePromptSessions.add("session-1");
    internals.connection = { signal: { aborted: false }, extMethod };

    await controller.compactSession("session-1");

    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: "session-1",
      operation: "compaction.run",
      input: {},
    });
    controller.dispose();
  });

  it("runs compaction for a terminal-owned session without attaching a second provider", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const extMethod = vi.fn().mockResolvedValue({ ok: true });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
      terminalOnlySessions: Set<string>;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, extMethod };
    internals.terminalOnlySessions.add("session-1");

    await controller.compactSession("session-1");

    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: "session-1",
      operation: "compaction.run",
      input: {},
    });
    controller.dispose();
  });

  it("publishes compaction progress until the control operation finishes", async () => {
    const events: AgentEvent[] = [];
    let finishCompaction: (() => void) | undefined;
    const compaction = new Promise<void>((resolve) => {
      finishCompaction = resolve;
    });
    const extMethod = vi
      .fn()
      .mockImplementation((_method: string, params: { operation?: string }) => {
        if (params.operation === "compaction.run")
          return compaction.then(() => ({ ok: true }));
        return Promise.resolve({ page: { items: [] } });
      });
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
      sessions: Map<string, ReturnType<typeof sessionInfoToAgentSession>>;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, extMethod };
    internals.sessions.set(
      "session-1",
      sessionInfoToAgentSession({
        sessionId: "session-1",
        cwd: "/tmp/project",
      }),
    );

    const pending = controller.compactSession("session-1");
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.updated",
          session: expect.objectContaining({
            id: "session-1",
            phase: "compacting",
            status: "running",
          }),
        }),
      ),
    );
    finishCompaction?.();
    await pending;

    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "session.updated",
        session: expect.objectContaining({ id: "session-1", phase: undefined }),
      }),
    );
    controller.dispose();
  });

  it("queues steer on the persistent control transport", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const brokerControl = vi.fn().mockResolvedValue({ turn: "stopped" });
    const extMethod = vi.fn().mockResolvedValue({ ok: true, accepted: true });
    const internals = controller as unknown as {
      brokerControl: typeof brokerControl;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
    };
    internals.brokerControl = brokerControl;
    internals.connection = { signal: { aborted: false }, extMethod };

    await controller.steerSession("session-1", {
      text: "/steer focus on the failing test",
      images: [],
      files: [],
    });

    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: "session-1",
      operation: "turn.steer",
      input: expect.objectContaining({
        text: "focus on the failing test",
        clientRef: expect.stringMatching(/^gajae-steer-/u),
      }),
    });
    expect(brokerControl).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("falls back to the broker when the persistent transport cannot control the session", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const brokerControl = vi.fn().mockResolvedValue({ turn: "stopped" });
    const extMethod = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: "bridge_unavailable" } });
    const internals = controller as unknown as {
      brokerControl: typeof brokerControl;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
    };
    internals.brokerControl = brokerControl;
    internals.connection = { signal: { aborted: false }, extMethod };

    await controller.steerSession("session-1", {
      text: "focus now",
      images: [],
      files: [],
    });

    expect(brokerControl).toHaveBeenCalledWith(
      "session-1",
      "turn.steer",
      expect.objectContaining({
        text: "focus now",
        clientRef: expect.stringMatching(/^gajae-steer-/u),
      }),
    );
    controller.dispose();
  });

  it("flushes queued steer by aborting the current turn instead of resubmitting it", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const brokerControl = vi.fn().mockResolvedValue({ aborted: true });
    const extMethod = vi.fn().mockImplementation((_method, params) => {
      if (params.query === "queue.messages.list") {
        return Promise.resolve({
          page: {
            items: [{ id: "steer-1", text: "focus now", mode: "steer" }],
            complete: true,
          },
        });
      }
      return Promise.resolve({ ok: true, accepted: true, aborted: true });
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      brokerControl: typeof brokerControl;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
      sessions: Map<string, ReturnType<typeof sessionInfoToAgentSession>>;
    };
    internals.startup = Promise.resolve();
    internals.brokerControl = brokerControl;
    internals.connection = { signal: { aborted: false }, extMethod };
    internals.sessions.set(
      "session-1",
      sessionInfoToAgentSession({
        sessionId: "session-1",
        cwd: "/tmp/project",
      }),
    );

    await expect(controller.flushQueuedNow("session-1")).resolves.toBe(true);

    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: "session-1",
      operation: "turn.abort",
      input: {},
    });
    expect(extMethod).not.toHaveBeenCalledWith(
      "_gjc/sdk/control",
      expect.objectContaining({ operation: "queue.message.remove" }),
    );
    expect(extMethod).not.toHaveBeenCalledWith(
      "_gjc/sdk/control",
      expect.objectContaining({ operation: "turn.abort_and_prompt" }),
    );
    expect(brokerControl).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("waits for an in-flight steer before flushing the queue", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const brokerControl = vi.fn();
    let resolveSteer: (() => void) | undefined;
    const steer = new Promise<void>((resolve) => {
      resolveSteer = resolve;
    });
    let listedAfterSteer = false;
    const extMethod = vi.fn().mockImplementation((_method, params) => {
      if (params.operation === "turn.steer")
        return steer.then(() => ({ ok: true }));
      if (params.query === "queue.messages.list") {
        if (!listedAfterSteer) {
          return Promise.resolve({ page: { items: [], complete: true } });
        }
        return Promise.resolve({
          page: {
            items: [{ id: "steer-1", text: "focus now", mode: "steer" }],
            complete: true,
          },
        });
      }
      return Promise.resolve({ ok: true, accepted: true, aborted: true });
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      brokerControl: typeof brokerControl;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
    };
    internals.startup = Promise.resolve();
    internals.brokerControl = brokerControl;
    internals.connection = { signal: { aborted: false }, extMethod };

    const steered = controller.steerSession("session-1", {
      text: "focus now",
      images: [],
      files: [],
    });
    const flushed = controller.flushQueuedNow("session-1");
    listedAfterSteer = true;
    resolveSteer?.();
    await steered;
    await expect(flushed).resolves.toBe(true);
    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: "session-1",
      operation: "turn.abort",
      input: {},
    });
    expect(brokerControl).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("waits for a just-queued steer before flushing instead of no-opping", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const brokerControl = vi.fn();
    let lists = 0;
    const extMethod = vi.fn().mockImplementation((_method, params) => {
      if (params.query === "queue.messages.list") {
        lists += 1;
        if (lists < 3) {
          return Promise.resolve({ page: { items: [], complete: true } });
        }
        return Promise.resolve({
          page: {
            items: [{ id: "steer-1", text: "focus now", mode: "steer" }],
            complete: true,
          },
        });
      }
      return Promise.resolve({ ok: true, accepted: true, aborted: true });
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      brokerControl: typeof brokerControl;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
    };
    internals.startup = Promise.resolve();
    internals.brokerControl = brokerControl;
    internals.connection = { signal: { aborted: false }, extMethod };

    await expect(controller.flushQueuedNow("session-1")).resolves.toBe(true);
    expect(lists).toBeGreaterThanOrEqual(3);
    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: "session-1",
      operation: "turn.abort",
      input: {},
    });
    expect(brokerControl).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("treats an abort ACK drop as a successful flush instead of retrying through the broker", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const brokerControl = vi.fn();
    const extMethod = vi.fn().mockImplementation((_method, params) => {
      if (params.query === "queue.messages.list") {
        return Promise.resolve({
          page: {
            items: [{ id: "steer-1", text: "focus now", mode: "steer" }],
            complete: true,
          },
        });
      }
      return Promise.reject(
        new Error("SDK request outcome is uncertain after the frame was sent."),
      );
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      brokerControl: typeof brokerControl;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
    };
    internals.startup = Promise.resolve();
    internals.brokerControl = brokerControl;
    internals.connection = { signal: { aborted: false }, extMethod };

    await expect(controller.flushQueuedNow("session-1")).resolves.toBe(true);
    expect(brokerControl).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("queues a composer submission as follow-up while its prompt is active", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const brokerControl = vi.fn().mockResolvedValue({ turn: "stopped" });
    const prompt = vi.fn();
    const extMethod = vi.fn().mockResolvedValue({ ok: true, accepted: true });
    const internals = controller as unknown as {
      startup: Promise<void>;
      activePromptSessions: Set<string>;
      brokerControl: typeof brokerControl;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
    };
    internals.startup = Promise.resolve();
    internals.activePromptSessions.add("session-1");
    internals.brokerControl = brokerControl;
    internals.connection = { signal: { aborted: false }, extMethod };

    await controller.sendMessage("session-1", {
      text: "check the narrower failure",
      images: [],
      files: [],
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: "session-1",
      operation: "turn.follow_up",
      input: { text: "check the narrower failure" },
    });
    expect(brokerControl).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("routes an explicit steer directly even when external run status is stale", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const brokerControl = vi.fn().mockResolvedValue({ turn: "stopped" });
    const internals = controller as unknown as {
      brokerControl: typeof brokerControl;
    };
    internals.brokerControl = brokerControl;

    await controller.sendMessage("session-1", {
      text: "/steer stop searching and answer now",
      images: [],
      files: [],
    });

    expect(brokerControl).toHaveBeenCalledWith(
      "session-1",
      "turn.steer",
      expect.objectContaining({
        text: "stop searching and answer now",
        clientRef: expect.stringMatching(/^gajae-steer-/u),
      }),
    );
    controller.dispose();
  });

  it("queues an ordinary prompt as follow-up when the remote session became busy without adding a failure notice", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const prompt = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Internal error: turn.prompt is unavailable while the agent is busy; use turn.steer explicitly.",
        ),
      );
    const extMethod = vi.fn().mockResolvedValue({ ok: true });
    const brokerControl = vi.fn().mockResolvedValue({ turn: "stopped" });
    const session = sessionInfoToAgentSession({
      sessionId: "session-1",
      cwd: "/tmp/project",
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        prompt: typeof prompt;
      };
      attachedSessions: Set<string>;
      sessions: Map<string, typeof session>;
      brokerControl: typeof brokerControl;
    };
    internals.startup = Promise.resolve();
    internals.attachedSessions.add(session.id);
    internals.sessions.set(session.id, session);
    internals.connection = { signal: { aborted: false }, extMethod, prompt };
    internals.brokerControl = brokerControl;

    await expect(
      controller.sendMessage(session.id, {
        text: "focus the active run",
        images: [],
        files: [],
      }),
    ).resolves.toBeUndefined();

    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: session.id,
      operation: "turn.follow_up",
      input: { text: "focus the active run" },
    });
    expect(brokerControl).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "transcript.appended",
        item: expect.objectContaining({ title: "GJC run failed" }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "session.activity", category: "failed" }),
    );
    controller.dispose();
  });

  it("renders a cancelled prompt as a Korean neutral notice instead of a failure", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const prompt = vi.fn().mockRejectedValue(new Error("Operation aborted"));
    const extMethod = vi.fn().mockResolvedValue({ page: { items: [] } });
    const session = sessionInfoToAgentSession({
      sessionId: "session-1",
      cwd: "/tmp/project",
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        prompt: typeof prompt;
      };
      attachedSessions: Set<string>;
      sessions: Map<string, typeof session>;
    };
    internals.startup = Promise.resolve();
    internals.attachedSessions.add(session.id);
    internals.sessions.set(session.id, session);
    internals.connection = { signal: { aborted: false }, extMethod, prompt };

    await expect(
      controller.sendMessage(session.id, {
        text: "stop me",
        images: [],
        files: [],
      }),
    ).resolves.toBeUndefined();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "transcript.appended",
        item: expect.objectContaining({
          title: "작업 취소됨",
          content: "진행 중인 작업이 취소되어 종료됐습니다.",
          tone: "neutral",
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "session.activity", category: "failed" }),
    );
    controller.dispose();
  });

  it("cancels the active turn and its owned subagents through ACP", async () => {
    const settle = new Set<string>();
    const cancel = vi.fn().mockImplementation(async () => {
      for (const id of settle) internals.activePromptSessions.delete(id);
    });
    const extMethod = vi.fn().mockResolvedValue({ ok: true });
    const brokerControl = vi.fn().mockResolvedValue({ aborted: true });
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const session = sessionInfoToAgentSession({
      sessionId: "session-1",
      cwd: "/tmp/project",
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        cancel: typeof cancel;
        extMethod: typeof extMethod;
      };
      activePromptSessions: Set<string>;
      sessions: Map<string, typeof session>;
      brokerControl: typeof brokerControl;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, cancel, extMethod };
    internals.brokerControl = brokerControl;
    internals.activePromptSessions.add(session.id);
    settle.add(session.id);
    internals.sessions.set(session.id, { ...session, status: "running" });
    const pending = controller.cancelRun(session.id);
    expect(internals.sessions.get(session.id)?.status).toBe("idle");
    await pending;

    expect(cancel).toHaveBeenCalledWith({
      sessionId: session.id,
      _meta: { gjc: { abortScope: "owned" } },
    });
    expect(extMethod).toHaveBeenCalledWith(
      "_gjc/sdk/control",
      expect.objectContaining({
        sessionId: session.id,
        operation: "turn.abort",
      }),
    );
    expect(brokerControl).toHaveBeenCalledWith(
      session.id,
      "turn.abort",
      { mode: "terminal", scope: "owned", operator: true },
      expect.stringMatching(/^gajae-abort-/u),
    );
    expect(brokerControl).toHaveBeenCalledWith(session.id, "turn.abort", {});
    expect(internals.sessions.get(session.id)?.status).toBe("idle");
    controller.dispose();
  });

  it("falls back to broker turn cancellation when ACP transports fail", async () => {
    const cancel = vi
      .fn()
      .mockRejectedValue(new Error("ACP cancel unavailable"));
    const extMethod = vi
      .fn()
      .mockRejectedValue(new Error("persistent control unavailable"));
    const brokerControl = vi
      .fn()
      .mockImplementation(
        (
          _sessionId: string,
          _operation: string,
          input: Record<string, unknown>,
        ) =>
          input.mode === "terminal"
            ? Promise.resolve({ turn: "stopped" })
            : (internals.activePromptSessions.delete(_sessionId),
              Promise.resolve({ aborted: true })),
      );
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        cancel: typeof cancel;
        extMethod: typeof extMethod;
      };
      activePromptSessions: Set<string>;
      brokerControl: typeof brokerControl;
      cancelSettleMs: number;
      cancelEscalationMs: number;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, cancel, extMethod };
    internals.activePromptSessions.add("session-1");
    internals.brokerControl = brokerControl;
    internals.cancelSettleMs = 20;
    internals.cancelEscalationMs = 40;

    await controller.cancelRun("session-1");
    await Promise.resolve();

    expect(cancel).toHaveBeenCalled();
    expect(extMethod).toHaveBeenCalledWith(
      "_gjc/sdk/control",
      expect.objectContaining({
        sessionId: "session-1",
        operation: "turn.abort",
      }),
    );
    expect(brokerControl).toHaveBeenCalledWith(
      "session-1",
      "turn.abort",
      { mode: "terminal", scope: "owned", operator: true },
      expect.stringMatching(/^gajae-abort-/u),
    );
    expect(brokerControl).toHaveBeenCalledWith("session-1", "turn.abort", {});
    controller.dispose();
  });

  it("cancels externally driven work through persistent control with an idempotency key", async () => {
    const extMethod = vi.fn().mockResolvedValue({ turn: "stopped" });
    const brokerControl = vi.fn().mockResolvedValue({ turn: "stopped" });
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const session = sessionInfoToAgentSession({
      sessionId: "session-1",
      cwd: "/tmp/project",
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
      sessions: Map<string, typeof session>;
      brokerControl: typeof brokerControl;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, extMethod };
    internals.brokerControl = brokerControl;
    internals.sessions.set(session.id, { ...session, status: "running" });

    await controller.cancelRun(session.id);

    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: session.id,
      operation: "turn.abort",
      input: {
        mode: "terminal",
        scope: "owned",
        operator: true,
        confirm: true,
        idempotencyKey: expect.stringMatching(/^gajae-abort-/u),
      },
    });
    expect(brokerControl).toHaveBeenCalledWith(
      session.id,
      "turn.abort",
      { mode: "terminal", scope: "owned", operator: true },
      expect.stringMatching(/^gajae-abort-/u),
    );
    expect(brokerControl).toHaveBeenCalledWith(session.id, "turn.abort", {});
    expect(internals.sessions.get(session.id)?.status).toBe("idle");
    controller.dispose();
  });

  it("retries an unresolved direct abort through the broker with the same key", async () => {
    const extMethod = vi.fn().mockResolvedValue({ ok: true });
    const brokerControl = vi
      .fn()
      .mockImplementation(
        (
          _sessionId: string,
          _operation: string,
          input: Record<string, unknown>,
        ) =>
          input.mode === "terminal"
            ? Promise.resolve({
                turn: "no_active_turn",
                terminal: "terminal_no_effect",
              })
            : Promise.resolve({ aborted: true, disposition: "idle" }),
      );
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const session = sessionInfoToAgentSession({
      sessionId: "session-1",
      cwd: "/tmp/project",
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
      sessions: Map<string, typeof session>;
      brokerControl: typeof brokerControl;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, extMethod };
    internals.brokerControl = brokerControl;
    internals.sessions.set(session.id, { ...session, status: "running" });

    await controller.cancelRun(session.id);

    const directInput = extMethod.mock.calls[0]?.[1]?.input as
      Record<string, unknown> | undefined;
    expect(directInput?.idempotencyKey).toEqual(
      expect.stringMatching(/^gajae-abort-/u),
    );
    expect(brokerControl).toHaveBeenCalledWith(
      session.id,
      "turn.abort",
      { mode: "terminal", scope: "owned", operator: true },
      directInput?.idempotencyKey,
    );
    expect(brokerControl).toHaveBeenLastCalledWith(
      session.id,
      "turn.abort",
      {},
    );
    expect(internals.sessions.get(session.id)?.status).toBe("idle");
    controller.dispose();
  });

  it("falls back to the TUI session abort when terminal abort is unsupported", async () => {
    const extMethod = vi.fn().mockResolvedValue({
      ok: false,
      error: { message: "Unknown turn.abort terminal field: operator" },
    });
    const brokerControl = vi
      .fn()
      .mockImplementation(
        (
          _sessionId: string,
          operation: string,
          input: Record<string, unknown>,
        ) =>
          operation === "turn.abort" && input.operator === true
            ? Promise.reject(
                new Error("Unknown turn.abort terminal field: operator"),
              )
            : Promise.resolve({ aborted: true, disposition: "idle" }),
      );
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
      brokerControl: typeof brokerControl;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, extMethod };
    internals.brokerControl = brokerControl;

    await controller.cancelRun("legacy-session");

    expect(brokerControl).toHaveBeenNthCalledWith(
      1,
      "legacy-session",
      "turn.abort",
      { mode: "terminal", scope: "owned", operator: true },
      expect.stringMatching(/^gajae-abort-/u),
    );
    expect(brokerControl).toHaveBeenNthCalledWith(
      2,
      "legacy-session",
      "turn.abort",
      {},
    );
    controller.dispose();
  });

  it("queues a follow-up behind the active turn", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const extMethod = vi.fn().mockResolvedValue({ accepted: true });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
      attachedSessions: Set<string>;
    };
    internals.startup = Promise.resolve();
    internals.attachedSessions.add("session-1");
    internals.connection = { signal: { aborted: false }, extMethod };

    await controller.queueFollowUp("session-1", {
      text: "run the focused tests next",
      images: [],
      files: [],
    });

    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: "session-1",
      operation: "turn.follow_up",
      input: { text: "run the focused tests next" },
    });
    controller.dispose();
  });

  it("hydrates sidebar context usage from the current context snapshot", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: () => Promise<unknown>;
      };
      sessions: Map<string, ReturnType<typeof sessionInfoToAgentSession>>;
      refreshContextUsage(sessionId: string): Promise<void>;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(
      "session-1",
      sessionInfoToAgentSession({
        sessionId: "session-1",
        cwd: "/tmp/project",
      }),
    );
    internals.connection = {
      signal: { aborted: false },
      extMethod: () =>
        Promise.resolve({
          page: {
            items: [
              { usage: { tokens: 222, contextWindow: 1_000, percent: 22.2 } },
            ],
          },
        }),
    };

    await internals.refreshContextUsage("session-1");

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.updated",
        session: expect.objectContaining({
          id: "session-1",
          usagePercent: 22.2,
          usagePending: false,
        }),
      }),
    );
    controller.dispose();
  });

  it("clears stale context usage while GJC waits for a post-compaction anchor", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const session = {
      ...sessionInfoToAgentSession({
        sessionId: "session-1",
        cwd: "/tmp/project",
      }),
      usagePercent: 81.5,
    };
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: () => Promise<unknown>;
      };
      sessions: Map<string, typeof session>;
      refreshContextUsage(sessionId: string): Promise<void>;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set("session-1", session);
    internals.connection = {
      signal: { aborted: false },
      extMethod: () =>
        Promise.resolve({
          page: {
            items: [
              {
                usage: {
                  tokens: null,
                  contextWindow: 200_000,
                  percent: null,
                  source: "unknown",
                },
              },
            ],
          },
        }),
    };

    await internals.refreshContextUsage("session-1");

    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "session.updated",
        session: expect.objectContaining({
          id: "session-1",
          usagePercent: undefined,
          usagePending: true,
        }),
      }),
    );
    controller.dispose();
  });

  it("projects goal progress and controls the live goal", async () => {
    const extMethod = vi
      .fn()
      .mockImplementation(
        (_method: string, params: { query?: string; operation?: string }) => {
          if (params.operation === "mode.goal.operate")
            return Promise.resolve({ ok: true });
          if (params.query === "goal.list/get")
            return Promise.resolve({
              page: {
                complete: true,
                items: [
                  {
                    enabled: true,
                    mode: "active",
                    goal: { objective: "Ship the desktop", status: "active" },
                  },
                ],
              },
            });
          if (params.query === "todo.list")
            return Promise.resolve({
              page: {
                complete: true,
                items: [
                  {
                    tasks: [{ status: "completed" }, { status: "in_progress" }],
                  },
                ],
              },
            });
          return Promise.resolve({ page: { complete: true, items: [] } });
        },
      );
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, extMethod };

    await expect(controller.getGoal("session-1")).resolves.toEqual({
      enabled: true,
      mode: "active",
      objective: "Ship the desktop",
      completed: 1,
      total: 2,
    });
    await expect(
      controller.operateGoal("session-1", "pause"),
    ).resolves.toMatchObject({ enabled: true });
    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: "session-1",
      operation: "mode.goal.operate",
      input: { op: "pause" },
    });
    controller.dispose();
  });

  it("projects live runtime subagent jobs", async () => {
    const extMethod = vi.fn().mockResolvedValue({
      page: {
        complete: true,
        items: [
          {
            id: "job-1",
            kind: "subagent",
            role: "executor",
            status: "blocked",
            description: "Waiting for review",
          },
        ],
      },
    });
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, extMethod };

    await expect(controller.listSubagents("session-1")).resolves.toEqual([
      {
        id: "job-1",
        label: "executor",
        status: "waiting",
        detail: "Waiting for review",
      },
    ]);
    controller.dispose();
  });

  it("deduplicates repeated task launch attempts by subagent id", async () => {
    const extMethod = vi
      .fn()
      .mockResolvedValue({ page: { complete: true, items: [] } });
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const first = {
      id: "agent-1",
      label: "Old attempt",
      role: "architect",
      objective: "Old assignment",
      status: "failed" as const,
    };
    const latest = {
      ...first,
      label: "Actual launch",
      objective: "Current assignment",
      status: "running" as const,
    };
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
      transcripts: Map<string, TranscriptItem[]>;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, extMethod };
    internals.transcripts.set("session-1", [
      {
        id: "task-1",
        sessionId: "session-1",
        kind: "tool",
        name: "task",
        description: "first",
        status: "failed",
        createdAt: "now",
        subagents: [first],
      },
      {
        id: "task-2",
        sessionId: "session-1",
        kind: "tool",
        name: "task",
        description: "second",
        status: "running",
        createdAt: "now",
        subagents: [latest],
      },
    ]);

    await expect(controller.listSubagents("session-1")).resolves.toEqual([
      latest,
    ]);
    controller.dispose();
  });

  it("releases retained session state when disposed", () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      sessions: Map<string, unknown>;
      transcripts: Map<string, TranscriptItem[]>;
      messageKeys: Map<string, Map<string, string>>;
      sessionCommands: Map<string, unknown[]>;
      sessionConfig: Map<string, unknown[]>;
      modelProfiles: Map<string, unknown[]>;
    };
    internals.sessions.set("session-1", {});
    internals.transcripts.set("session-1", []);
    internals.messageKeys.set("session-1", new Map([["external", "local"]]));
    internals.sessionCommands.set("session-1", []);
    internals.sessionConfig.set("session-1", []);
    internals.modelProfiles.set("session-1", []);

    controller.dispose();

    expect(internals.sessions.size).toBe(0);
    expect(internals.transcripts.size).toBe(0);
    expect(internals.messageKeys.size).toBe(0);
    expect(internals.sessionCommands.size).toBe(0);
    expect(internals.sessionConfig.size).toBe(0);
    expect(internals.modelProfiles.size).toBe(0);
  });
});

describe("listSessions runtime preservation", () => {
  it("keeps model, context usage, and active status across discovery refreshes", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const listed = {
      sessionId: "session-1",
      cwd: "/tmp/project",
      title: "Session",
    };
    const existing = {
      ...sessionInfoToAgentSession(listed),
      status: "running" as const,
      model: "dusk",
      modelDisplay: "GPT-5.6 Sol",
      thinking: "medium",
      usagePercent: 42,
    };
    const extMethod = vi.fn().mockResolvedValue({ result: { sessions: [] } });
    const listSessions = vi.fn().mockResolvedValue({ sessions: [listed] });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        listSessions: typeof listSessions;
      };
      sessions: Map<string, typeof existing>;
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      listSessions,
    };
    internals.sessions.set(existing.id, existing);

    await expect(controller.listSessions()).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        status: "running",
        model: "dusk",
        modelDisplay: "GPT-5.6 Sol",
        thinking: "medium",
        usagePercent: 42,
      }),
    ]);
    controller.dispose();
  });
});

describe("inferToolName", () => {
  it("recovers CLI tool identities hidden by generic ACP kinds", () => {
    expect(
      inferToolName({
        sessionUpdate: "tool_call",
        toolCallId: "todo",
        title: "Updating tasks",
        kind: "think",
        status: "pending",
        rawInput: { ops: [] },
      }),
    ).toBe("todo_write");
    expect(
      inferToolName({
        sessionUpdate: "tool_call",
        toolCallId: "bash",
        title: "Checking process",
        kind: "execute",
        status: "pending",
        rawInput: { command: "pgrep Gajae" },
      }),
    ).toBe("bash");
    expect(
      inferToolName({
        sessionUpdate: "tool_call",
        toolCallId: "search-tools",
        title: "Finding tools",
        kind: "other",
        status: "pending",
        rawInput: { query: "todo", limit: 5 },
      }),
    ).toBe("search_tool_bm25");
    expect(
      inferToolName({
        sessionUpdate: "tool_call",
        toolCallId: "find",
        title: "Finding files",
        kind: "search",
        status: "pending",
        rawInput: { paths: ["src/**"] },
      }),
    ).toBe("find");
  });
});

describe("isControllerSession", () => {
  it("filters the app ACP child even after its endpoint becomes attachable", () => {
    expect(
      isControllerSession(
        { repo: "/tmp/project", endpointGeneration: 2, pid: 42 },
        42,
        "/tmp/project",
      ),
    ).toBe(true);
    expect(
      isControllerSession(
        { repo: "/tmp/project", endpointGeneration: 2, pid: 99 },
        42,
        "/tmp/project",
      ),
    ).toBe(false);
  });

  it("filters the non-attachable control placeholder in the app workspace", () => {
    expect(
      isControllerSession(
        { repo: "/tmp/project", endpointGeneration: 0 },
        42,
        "/tmp/project",
      ),
    ).toBe(true);
    expect(
      isControllerSession(
        { repo: "/tmp/other", endpointGeneration: 0 },
        42,
        "/tmp/project",
      ),
    ).toBe(false);
  });
});

describe("busyPromptError", () => {
  it("recognizes current and legacy busy prompt responses", () => {
    expect(
      busyPromptError(
        new Error(
          "Internal error: turn.prompt is unavailable while the agent is busy; use turn.steer explicitly.",
        ),
      ),
    ).toBe(true);
    expect(
      busyPromptError(new Error("ACP session already has an active prompt")),
    ).toBe(true);
    expect(busyPromptError(new Error("network unavailable"))).toBe(false);
  });
});

describe("uncertainAfterSendError", () => {
  it("recognizes dropped SDK acknowledgements", () => {
    expect(
      uncertainAfterSendError(
        new Error("SDK request outcome is uncertain after the frame was sent."),
      ),
    ).toBe(true);
    expect(uncertainAfterSendError(new Error("network unavailable"))).toBe(
      false,
    );
  });
});

describe("GjcAcpController MUST surfaces", () => {
  it("forwards only the exact permission option selected by the user", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const internals = controller as unknown as {
      requestPermission(request: unknown): Promise<unknown>;
    };
    const response = internals.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-1",
        name: "bash",
        title: "Run tests",
        status: "pending",
      },
      options: [
        { optionId: "once", kind: "allow_once", name: "이번만 허용" },
        { optionId: "always", kind: "allow_always", name: "항상 허용" },
        { optionId: "reject", kind: "reject_once", name: "거부" },
      ],
    });

    await expect(
      controller.resolveToolCall("tool-1", { optionId: "invented" }),
    ).rejects.toThrow("Unknown permission option");
    await controller.resolveToolCall("tool-1", { optionId: "always" });

    await expect(response).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "always" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.updated",
        tool: expect.objectContaining({
          permissionOptions: expect.arrayContaining([
            expect.objectContaining({
              optionId: "always",
              kind: "allow_always",
            }),
          ]),
        }),
      }),
    );
    controller.dispose();
  });

  it("reads complete diff snapshots through the typed SDK query", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const extMethod = vi.fn().mockResolvedValue({
      page: {
        complete: true,
        items: [
          {
            id: "src/app.ts",
            path: "src/app.ts",
            body: "diff --git a/src/app.ts b/src/app.ts",
          },
        ],
      },
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
      attachedSessions: Set<string>;
    };
    internals.startup = Promise.resolve();
    internals.attachedSessions.add("session-1");
    internals.connection = { signal: { aborted: false }, extMethod };

    await expect(controller.getDiff("session-1")).resolves.toMatchObject({
      files: [
        {
          id: "src/app.ts",
          path: "src/app.ts",
          patch: "diff --git a/src/app.ts b/src/app.ts",
        },
      ],
    });
    expect(extMethod).toHaveBeenCalledWith(
      "_gjc/sdk/query",
      expect.objectContaining({ query: "diff.list_files" }),
    );
    controller.dispose();
  });

  it("persists and reads full local tool artifacts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gajae-artifacts-"));
    try {
      const controller = new GjcAcpController({
        workspace: "/tmp/project",
        artifactDirectory: directory,
        emit: () => undefined,
      });
      const internals = controller as unknown as {
        persistArtifact(artifactId: string, value: unknown): Promise<void>;
      };
      const fullText = "full output\n".repeat(2_000);
      await internals.persistArtifact("tool-output", fullText);

      await expect(
        controller.readArtifact("session-1", "tool-output"),
      ).resolves.toEqual({
        artifactId: "tool-output",
        text: fullText,
        complete: true,
        totalBytes: Buffer.byteLength(fullText),
      });
      controller.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("previews generated files inside the session workspace and rejects outside paths", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "gajae-preview-"));
    const outside = path.join(tmpdir(), `gajae-outside-${Date.now()}.md`);
    try {
      const generated = path.join(workspace, "report.md");
      await writeFile(generated, "# Result\n");
      await writeFile(outside, "# Outside\n");
      const controller = new GjcAcpController({
        workspace,
        emit: () => undefined,
      });

      await expect(
        controller.previewFile("session-1", generated),
      ).resolves.toMatchObject({
        path: await realpath(generated),
        name: "report.md",
        kind: "markdown",
        mimeType: "text/markdown",
        content: "# Result\n",
      });
      await expect(
        controller.previewFile("session-1", outside),
      ).rejects.toThrow("inside the session workspace");
      controller.dispose();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it("projects effective runtime state from live SDK queries", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      permissionHandling: "auto",
      emit: (event) => events.push(event),
    });
    const session = {
      ...sessionInfoToAgentSession({
        sessionId: "session-1",
        cwd: "/tmp/project",
      }),
      model: "GOAT",
      thinking: "high",
    };
    const extMethod = vi
      .fn()
      .mockImplementation((_method: string, params: { query: string }) =>
        Promise.resolve({
          page: {
            complete: true,
            items:
              params.query === "skill.list/state"
                ? [{ name: "ralplan" }]
                : params.query === "tools.list"
                  ? [{ name: "read" }]
                  : params.query === "config.list/get"
                    ? [
                        { key: "mcp.servers", value: ["context7"] },
                        { key: "rules.files", value: ["AGENTS.md"] },
                      ]
                    : [],
          },
        }),
      );
    const internals = controller as unknown as {
      startup: Promise<void>;
      sessions: Map<string, typeof session>;
      attachedSessions: Set<string>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(session.id, session);
    internals.attachedSessions.add(session.id);
    internals.connection = { signal: { aborted: false }, extMethod };

    await expect(
      controller.refreshRuntimeState(session.id),
    ).resolves.toMatchObject({
      modelProfile: "GOAT",
      thinking: "high",
      permissionHandling: "auto",
      mcpServers: ["context7"],
      rules: ["AGENTS.md"],
      skills: ["ralplan"],
      tools: ["read"],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "runtime.updated",
        sessionId: session.id,
      }),
    );
    controller.dispose();
  });

  it("creates an isolated managed worktree without modifying the primary checkout", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gajae-worktree-"));
    const repository = path.join(directory, "project");
    await mkdir(repository);
    try {
      await execFile("git", ["-C", repository, "init"]);
      await writeFile(
        path.join(repository, "README.txt"),
        "primary checkout\n",
      );
      await execFile("git", ["-C", repository, "add", "README.txt"]);
      await execFile("git", [
        "-C",
        repository,
        "-c",
        "user.name=Gajae Test",
        "-c",
        "user.email=gajae@example.test",
        "commit",
        "-m",
        "initial",
      ]);
      const newSession = vi.fn().mockResolvedValue({
        sessionId: "worktree-session",
        configOptions: [],
      });
      const controller = new GjcAcpController({
        workspace: repository,
        emit: () => undefined,
      });
      const internals = controller as unknown as {
        startup: Promise<void>;
        connection: {
          signal: { aborted: boolean };
          newSession: typeof newSession;
        };
      };
      internals.startup = Promise.resolve();
      internals.connection = { signal: { aborted: false }, newSession };

      const session = await controller.createSession({
        runtime: "gjc",
        title: "Isolated",
        workspace: repository,
        isolation: "worktree",
        worktreeBranch: "gajae/test-isolation",
      });

      expect(session.worktree).toMatchObject({
        sourceWorkspace: await realpath(repository),
        branch: "gajae/test-isolation",
        managed: true,
      });
      expect(session.workspace).not.toBe(repository);
      expect(newSession).toHaveBeenCalledWith({
        cwd: session.workspace,
        mcpServers: [],
      });
      expect(
        (
          await execFile("git", ["-C", repository, "status", "--porcelain"])
        ).stdout.trim(),
      ).toBe("");
      await writeFile(
        path.join(session.workspace, "feature.txt"),
        "isolated change\n",
      );
      expect((await controller.getGitStatus(session.id)).files).toContainEqual(
        expect.objectContaining({ path: "feature.txt", workingTree: "?" }),
      );
      await expect(
        controller.stageFiles(session.id, ["feature.txt"]),
      ).resolves.toMatchObject({
        files: [expect.objectContaining({ path: "feature.txt", index: "A" })],
      });
      controller.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(`${repository}.gajae-worktrees`, {
        recursive: true,
        force: true,
      });
    }
  });

  it("recovers the retained session when lifecycle creation evidence is uncertain", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const recovered = sessionInfoToAgentSession({
      sessionId: "retained-session",
      cwd: "/tmp/project",
      title: "Retained",
    });
    const newSession = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Lifecycle terminal evidence could not be verified after persistence; retained artifacts require reconciliation.",
        ),
      );
    const loadSession = vi.fn().mockResolvedValue({ configOptions: [] });
    const extMethod = vi
      .fn()
      .mockResolvedValueOnce({ result: { sessions: [] } })
      .mockResolvedValue({
        result: {
          sessions: [
            {
              sessionId: recovered.id,
              live: true,
              endpointGeneration: 1,
              locator: { repo: recovered.workspace },
            },
          ],
        },
      });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        newSession: typeof newSession;
        loadSession: typeof loadSession;
        extMethod: typeof extMethod;
      };
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      newSession,
      loadSession,
      extMethod,
    };

    await expect(
      controller.createSession({
        runtime: "gjc",
        workspace: "/tmp/project",
        isolation: "workspace",
        title: "Recovered",
      }),
    ).resolves.toMatchObject({
      id: recovered.id,
      title: "Recovered",
      ownership: "gajae",
      attachment: "attached",
      status: "idle",
    });
    expect(loadSession).toHaveBeenCalledWith({
      sessionId: recovered.id,
      cwd: recovered.workspace,
      mcpServers: [],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.created",
        session: expect.objectContaining({
          id: recovered.id,
          ownership: "gajae",
        }),
      }),
    );
    controller.dispose();
  });

  it("drains broker session-list cursors instead of leaking cursor capacity", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const extMethod = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          sessions: [{ sessionId: "one", live: true, endpointGeneration: 1 }],
          continuationCursor: "cursor-1",
        },
      })
      .mockResolvedValueOnce({
        result: {
          sessions: [{ sessionId: "two", live: true, endpointGeneration: 1 }],
        },
      });
    const brokerSessions = (
      controller as unknown as {
        brokerSessions(connection: {
          extMethod: typeof extMethod;
        }): Promise<Array<{ sessionId: string }>>;
      }
    ).brokerSessions.bind(controller);

    await expect(brokerSessions({ extMethod })).resolves.toEqual([
      expect.objectContaining({ sessionId: "one" }),
      expect.objectContaining({ sessionId: "two" }),
    ]);
    expect(extMethod).toHaveBeenNthCalledWith(1, "_gjc/sdk/global", {
      operation: "session.list",
      input: { limit: 100 },
    });
    expect(extMethod).toHaveBeenNthCalledWith(2, "_gjc/sdk/global", {
      operation: "session.list",
      input: { cursor: "cursor-1", limit: 100 },
    });
    controller.dispose();
  });

  it("forks through the typed ACP method and persists Gajae ownership", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const source = sessionInfoToAgentSession({
      sessionId: "source-session",
      cwd: "/tmp/project",
      title: "Source",
    });
    const unstableForkSession = vi
      .fn()
      .mockResolvedValue({ sessionId: "fork-session", configOptions: [] });
    const internals = controller as unknown as {
      startup: Promise<void>;
      sessions: Map<string, typeof source>;
      sessionCwds: Map<string, string>;
      attachedSessions: Set<string>;
      connection: {
        signal: { aborted: boolean };
        unstable_forkSession: typeof unstableForkSession;
      };
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(source.id, source);
    internals.sessionCwds.set(source.id, "/tmp/project");
    internals.attachedSessions.add(source.id);
    internals.connection = {
      signal: { aborted: false },
      unstable_forkSession: unstableForkSession,
    };

    await expect(
      controller.forkSession({ sourceSessionId: source.id, title: "Forked" }),
    ).resolves.toMatchObject({
      id: "fork-session",
      title: "Forked",
      ownership: "gajae",
      attachment: "attached",
      workspace: "/tmp/project",
    });
    expect(unstableForkSession).toHaveBeenCalledWith({
      sessionId: source.id,
      cwd: "/tmp/project",
      mcpServers: [],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.created",
        session: expect.objectContaining({ id: "fork-session" }),
      }),
    );
    controller.dispose();
  });

  it("rejects Git mutation outside a managed Gajae worktree", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp",
      emit: () => undefined,
    });
    const session = sessionInfoToAgentSession({
      sessionId: "plain-session",
      cwd: "/tmp",
    });
    const internals = controller as unknown as {
      sessions: Map<string, typeof session>;
      sessionCwds: Map<string, string>;
    };
    internals.sessions.set(session.id, session);
    internals.sessionCwds.set(session.id, "/tmp");

    await expect(
      controller.commitChanges(session.id, "unsafe"),
    ).rejects.toThrow("managed Gajae worktree");
    controller.dispose();
  });

  it("transports bounded text files as delimited user content", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    const internals = controller as unknown as {
      startup: Promise<void>;
      attachedSessions: Set<string>;
      sessions: Map<string, ReturnType<typeof sessionInfoToAgentSession>>;
      connection: { signal: { aborted: boolean }; prompt: typeof prompt };
    };
    internals.startup = Promise.resolve();
    internals.attachedSessions.add("session-1");
    internals.sessions.set(
      "session-1",
      sessionInfoToAgentSession({
        sessionId: "session-1",
        cwd: "/tmp/project",
      }),
    );
    internals.connection = { signal: { aborted: false }, prompt };

    await controller.sendMessage("session-1", {
      text: "Review this file",
      images: [],
      files: [
        {
          id: "file-1",
          name: "notes.txt",
          mimeType: "text/plain",
          size: 5,
          path: "/tmp/project/notes.txt",
        },
      ],
    });
    expect(prompt).toHaveBeenCalledWith({
      sessionId: "session-1",
      prompt: [
        {
          type: "text",
          text: expect.stringContaining('- "/tmp/project/notes.txt"'),
        },
      ],
    });
    controller.dispose();
  });
});

describe("thinkingOptionsForModelCatalog", () => {
  it("uses only the selected model profile valid levels", () => {
    expect(
      thinkingOptionsForModelCatalog(
        [
          {
            provider: "gajae-code",
            id: "ox",
            current: true,
            thinking: {
              validLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
            },
          },
          {
            provider: "gajae-code",
            id: "GOAT",
            current: false,
            thinking: { validLevels: ["off", "low", "high", "max"] },
          },
        ],
        "ox",
      ),
    ).toEqual([
      { value: "off", name: "off" },
      { value: "minimal", name: "minimal" },
      { value: "low", name: "low" },
      { value: "medium", name: "medium" },
      { value: "high", name: "high" },
      { value: "xhigh", name: "xhigh" },
    ]);
  });

  it("projects the selected profile default model label", () => {
    expect(
      profileDefaultModelLabel(
        [
          {
            provider: "gajae-code",
            id: "GOAT",
            profileDefaultModel: {
              provider: "codex-lb",
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
            },
          },
        ],
        "GOAT",
      ),
    ).toBe("GPT-5.6 Sol");
  });
});
