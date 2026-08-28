import { describe, expect, it, vi } from "vitest";
import {
  appendFile,
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
  sdkControlNeedsBrokerFallback,
  sessionInfoToAgentSession,
  sessionUnreachableError,
  historySessionSummary,
  sharedTranscriptItems,
  taskSubagents,
  thinkingOptionsForModelCatalog,
  toolDiffText,
  toolImageRefs,
  uncertainAfterSendError,
} from "./gjc-acp-controller.js";
import { GjcAcpController } from "./gjc-acp-controller.js";
import type {
  AgentEvent,
  AgentSession,
  ChatMessage,
  TranscriptItem,
} from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";

const execFile = promisify(execFileCallback);

describe("sessionUnreachableError", () => {
  it("recognizes a session with no published SDK endpoint", () => {
    expect(
      sessionUnreachableError(
        new Error(
          "SDK session 8ce8041a-fdab-4dcd-91f8-b7050fa9619c is unavailable through the session Router.",
        ),
      ),
    ).toBe(true);
    expect(sessionUnreachableError(new Error("session_unavailable"))).toBe(true);
    expect(
      sessionUnreachableError(new Error("no current Router attachment")),
    ).toBe(true);
  });

  it("does not claim an ordinary failure is an unreachable session", () => {
    // Misreading a real error as "terminal session" would hide the actual cause
    // and permanently mark a controllable row as uncontrollable.
    expect(sessionUnreachableError(new Error("GJC compaction.run failed"))).toBe(
      false,
    );
    expect(sessionUnreachableError(new Error("Operation aborted"))).toBe(false);
  });
});

describe("sdkControlNeedsBrokerFallback", () => {
  it("keeps a busy agent on the live connection instead of the broker CLI", () => {
    expect(
      sdkControlNeedsBrokerFallback({
        ok: false,
        error: {
          code: "unavailable",
          message:
            "turn.prompt is unavailable while the agent is busy; use turn.steer explicitly.",
        },
      }),
    ).toBe(false);
  });

  it("still falls back when the session is not reachable over the connection", () => {
    expect(
      sdkControlNeedsBrokerFallback({
        ok: false,
        error: { code: "not_found", message: "unknown session" },
      }),
    ).toBe(true);
  });
});

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

describe("patchSessionRuntime", () => {
  const controllerWith = (
    session: Record<string, unknown>,
  ): {
    patch: (patch: Record<string, unknown>) => void;
    events: AgentEvent[];
    dispose: () => void;
  } => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      sessions: Map<string, Record<string, unknown>>;
      patchSessionRuntime: (
        sessionId: string,
        patch: Record<string, unknown>,
      ) => void;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set("s", session);
    return {
      patch: (patch) => internals.patchSessionRuntime("s", patch),
      events,
      dispose: () => controller.dispose(),
    };
  };

  it("does not broadcast a patch that changes nothing", () => {
    // A turn re-asserts the same status and usage repeatedly. Each broadcast
    // re-renders the renderer's session subtree, so identical patches must be
    // dropped rather than amplified into IPC traffic.
    const { patch, events, dispose } = controllerWith({
      id: "s",
      status: "running",
      usagePercent: 40,
    });
    try {
      for (let index = 0; index < 20; index += 1) {
        patch({ status: "running" });
        patch({ usagePercent: 40 });
      }
      expect(
        events.filter((event) => event.type === "session.updated"),
      ).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("still broadcasts a real change", () => {
    const { patch, events, dispose } = controllerWith({
      id: "s",
      status: "running",
      usagePercent: 40,
    });
    try {
      patch({ usagePercent: 41 });
      patch({ status: "idle" });
      expect(
        events.filter((event) => event.type === "session.updated"),
      ).toHaveLength(2);
    } finally {
      dispose();
    }
  });

  it("broadcasts when a field is cleared", () => {
    // Clearing a phase is a real transition even though the new value is falsy.
    const { patch, events, dispose } = controllerWith({
      id: "s",
      status: "running",
      phase: "compacting",
    });
    try {
      patch({ phase: undefined });
      expect(
        events.filter((event) => event.type === "session.updated"),
      ).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});

describe("refreshContextUsage", () => {
  it("coalesces concurrent usage queries onto one round trip", async () => {
    // The usage query shares the ACP channel with the user's prompt and steer, so
    // a burst of transcript writes must not put a burst of queries ahead of them.
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      requireConnection: () => Promise<{
        extMethod: (name: string, input: unknown) => Promise<unknown>;
      }>;
      refreshContextUsage: (sessionId: string) => Promise<void>;
    };
    internals.startup = Promise.resolve();
    internals.requireConnection = () =>
      Promise.resolve({
        extMethod: async () => {
          calls += 1;
          await gate;
          return { ok: true, page: { items: [] } };
        },
      });

    const first = internals.refreshContextUsage("session-1");
    const second = internals.refreshContextUsage("session-1");
    const third = internals.refreshContextUsage("session-1");
    // The query starts after awaiting the connection, so let those microtasks run
    // before counting -- otherwise this asserts before any call was made.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);

    release();
    await Promise.all([first, second, third]);
    expect(calls).toBe(1);

    // Once settled, a later change is still allowed to query again.
    await internals.refreshContextUsage("session-1");
    expect(calls).toBe(2);
    controller.dispose();
  });
});

describe("publishTranscriptSync", () => {
  const item = (id: string, content: string): TranscriptItem =>
    ({
      kind: "message",
      id,
      sessionId: "s",
      role: "assistant",
      content,
      createdAt: "00:00",
    }) as TranscriptItem;

  const publish = (
    previous: TranscriptItem[] | undefined,
    next: TranscriptItem[],
  ): AgentEvent[] => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      publishTranscriptSync: (
        sessionId: string,
        previous: TranscriptItem[] | undefined,
        items: TranscriptItem[],
      ) => void;
    };
    internals.startup = Promise.resolve();
    internals.publishTranscriptSync("s", previous, next);
    controller.dispose();
    return events.filter((event) => event.type.startsWith("transcript."));
  };

  it("sends only the appended row instead of the whole history", () => {
    const history = [item("a", "one"), item("b", "two")];
    const events = publish(history, [...history, item("c", "three")]);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("transcript.appended");
    expect(
      events[0]?.type === "transcript.appended" ? events[0].item.id : undefined,
    ).toBe("c");
  });

  it("stays silent when a rescan changed nothing", () => {
    // The watcher fires for writes that do not alter the parsed history, and
    // republishing those re-rendered the transcript for no reason.
    const history = [item("a", "one")];
    expect(publish(history, [item("a", "one")])).toEqual([]);
  });

  it("republishes a row whose content changed in place", () => {
    const events = publish(
      [item("a", "one"), item("b", "partial")],
      [item("a", "one"), item("b", "complete")],
    );
    expect(events).toHaveLength(1);
    expect(
      events[0]?.type === "transcript.appended"
        ? events[0].item.id
        : undefined,
    ).toBe("b");
  });

  it("sends the full history when compaction rewrites it", () => {
    // A shorter history is not an append, so the renderer has to replace it.
    const events = publish([item("a", "one"), item("b", "two")], [item("z", "summary")]);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("transcript.synced");
  });

  it("sends the full history on the first load", () => {
    const events = publish(undefined, [item("a", "one")]);
    expect(events[0]?.type).toBe("transcript.synced");
  });

  it("does not rescan the whole history to find the appended row", () => {
    // Rebuilt rows are never reference-equal to the ones they replace, so
    // comparing every shared row cost a full structural compare per row (~9ms on
    // a 2500-row transcript). Only recent rows can still change, so the scan must
    // touch a bounded number of them regardless of history length.
    const previous = Array.from({ length: 2000 }, (_unused, index) =>
      item(`row-${index}`, `body ${index}`),
    );
    let compared = 0;
    const counted = previous.map(
      (item) =>
        new Proxy(item, {
          get(target, key, receiver) {
            if (key === "content") compared += 1;
            return Reflect.get(target, key, receiver) as unknown;
          },
        }) as TranscriptItem,
    );
    const events = publish(counted, [...previous, item("tail", "new")]);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("transcript.appended");
    // A full-prefix compare would touch all 2000 rows.
    expect(compared).toBeLessThan(64);
  });

  it("prefers one array over a burst of many appends", () => {
    const previous = [item("a", "one")];
    const next = [
      ...previous,
      ...Array.from({ length: 20 }, (_unused, index) =>
        item(`n${index}`, "row"),
      ),
    ];
    const events = publish(previous, next);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("transcript.synced");
  });
});

describe("readTranscriptEnvelopes", () => {
  const controllerFor = (): {
    read: (filePath: string) => Promise<Record<string, unknown>[]>;
    dispose: () => void;
  } => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      readTranscriptEnvelopes: (
        filePath: string,
        info: Awaited<ReturnType<typeof stat>>,
      ) => Promise<Record<string, unknown>[]>;
    };
    internals.startup = Promise.resolve();
    return {
      read: async (filePath) =>
        internals.readTranscriptEnvelopes(filePath, await stat(filePath)),
      dispose: () => controller.dispose(),
    };
  };

  const line = (id: string): string =>
    `${JSON.stringify({ type: "message", id, message: { role: "user", content: id } })}\n`;

  it("returns appended rows without reparsing the whole file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gjc-tail-"));
    const file = path.join(directory, "session.jsonl");
    const { read, dispose } = controllerFor();
    try {
      await writeFile(file, line("a") + line("b"), "utf8");
      expect((await read(file)).map((row) => row.id)).toEqual(["a", "b"]);

      await appendFile(file, line("c"), "utf8");
      // Reading only the tail must still yield the full history.
      expect((await read(file)).map((row) => row.id)).toEqual(["a", "b", "c"]);

      // An unchanged file replays the cached parse.
      expect((await read(file)).map((row) => row.id)).toEqual(["a", "b", "c"]);
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("joins a record split across two writes", async () => {
    // The watcher can fire while only part of a line is on disk. Parsing that
    // fragment as a whole record would drop the row permanently.
    const directory = await mkdtemp(path.join(tmpdir(), "gjc-torn-"));
    const file = path.join(directory, "session.jsonl");
    const { read, dispose } = controllerFor();
    try {
      const full = line("a");
      const cut = Math.floor(full.length / 2);
      await writeFile(file, full.slice(0, cut), "utf8");
      expect(await read(file)).toEqual([]);

      await appendFile(file, full.slice(cut), "utf8");
      expect((await read(file)).map((row) => row.id)).toEqual(["a"]);
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reparses from scratch when compaction rewrites the file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gjc-compact-"));
    const file = path.join(directory, "session.jsonl");
    const { read, dispose } = controllerFor();
    try {
      await writeFile(file, line("a") + line("b") + line("c"), "utf8");
      expect((await read(file)).map((row) => row.id)).toEqual(["a", "b", "c"]);

      // Compaction replaces the transcript with a shorter one. Treating the new
      // bytes as an append would concatenate two unrelated histories.
      await writeFile(file, line("z"), "utf8");
      expect((await read(file)).map((row) => row.id)).toEqual(["z"]);
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reparses when the path is replaced by a different file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gjc-swap-"));
    const file = path.join(directory, "session.jsonl");
    const replacement = path.join(directory, "next.jsonl");
    const { read, dispose } = controllerFor();
    try {
      await writeFile(file, line("a"), "utf8");
      expect((await read(file)).map((row) => row.id)).toEqual(["a"]);

      // Same path, same size, different inode: a size check alone would reuse
      // the stale parse and never show the new history.
      await writeFile(replacement, line("b"), "utf8");
      await rename(replacement, file);
      expect((await read(file)).map((row) => row.id)).toEqual(["b"]);
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("matches a full parse of the same file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gjc-parity-"));
    const file = path.join(directory, "session.jsonl");
    const incremental = controllerFor();
    const fresh = controllerFor();
    try {
      await writeFile(file, line("a") + line("b"), "utf8");
      await incremental.read(file);
      await appendFile(file, line("c") + line("d"), "utf8");
      const tailRead = await incremental.read(file);
      // A controller that never saw the earlier state parses the whole file.
      const fullRead = await fresh.read(file);
      expect(tailRead).toEqual(fullRead);
    } finally {
      incremental.dispose();
      fresh.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("historySessionSummary", () => {
  const line = (row: unknown): string => JSON.stringify(row);

  it("titles a session from its first user message and counts the turns", () => {
    expect(
      historySessionSummary([
        line({ type: "session", id: "s1", cwd: "/tmp/project" }),
        line({ type: "model_change" }),
        line({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "라우터 5자리 고치기" }],
          },
        }),
        line({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "네" }] },
        }),
        line({ type: "message", message: { role: "toolResult", content: [] } }),
      ]),
    ).toEqual({
      cwd: "/tmp/project",
      title: "라우터 5자리 고치기",
      messageCount: 2,
    });
  });

  it("never titles a session from an attachment block", () => {
    // The block is machinery, not intent, so a request that is only an
    // attachment must not become a title made of markup.
    expect(
      historySessionSummary([
        line({ type: "session", cwd: "/tmp/p" }),
        line({
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: '<local-images>\n- "/tmp/a.png"\n</local-images>',
              },
            ],
          },
        }),
      ]),
    ).toMatchObject({ messageCount: 1, cwd: "/tmp/p" });
    expect(
      historySessionSummary([
        line({ type: "session", cwd: "/tmp/p" }),
        line({
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: '<local-images>\n- "/tmp/a.png"\n</local-images>',
              },
            ],
          },
        }),
      ])?.title,
    ).toBeUndefined();
  });

  it("ignores a session file that holds no conversation", () => {
    expect(
      historySessionSummary([
        line({ type: "session", cwd: "/tmp/p" }),
        line({ type: "model_change" }),
        "",
        "{ torn line",
      ]),
    ).toBeUndefined();
  });
});

describe("sharedTranscriptItems", () => {
  it("labels every row from the row's own timestamp", () => {
    // Rows are labelled with one shared Intl formatter rather than a new one per
    // row. Reusing it must not leak state between rows or drift from the
    // timestamp each row carries.
    const reference = new Intl.DateTimeFormat("en", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const stamps = [
      "2026-08-25T01:05:00.000Z",
      "2026-08-25T23:45:00.000Z",
      "2026-08-25T12:00:00.000Z",
    ];
    const items = sharedTranscriptItems(
      "shared-session",
      stamps.map((ts, index) => ({
        id: `user-${index}`,
        role: "user",
        ts,
        content: [{ type: "text", text: `row ${index}` }],
      })),
    );
    expect(items.map((item) => item.createdAt)).toEqual(
      stamps.map((ts) => reference.format(new Date(ts))),
    );
  });

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
  it("gives every text part of one assistant row its own id", () => {
    // A row can carry a short lead-in, a thinking part, then the full answer.
    // All of them shared `shared-message-${sourceId}`, and a transcript keyed by
    // id rendered the same reply twice, once above and once below the tool card.
    const items = sharedTranscriptItems("shared-session", [
      {
        id: "assistant-multi",
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "lead in" },
          { type: "thinking", thinking: "" },
          { type: "text", text: "full answer" },
        ],
      },
    ]);
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      items.filter((item) => item.kind === "message").map((item) => item.id),
    ).toHaveLength(2);
  });
  it("settles a resultless tool call once the turn is no longer running", () => {
    // A finished turn ends on `stopReason: toolUse` whose call has no result row
    // yet. Reporting that as running kept the composer showing stop and routing
    // later messages into a steer after the turn had ended.
    const rows = [
      { id: "user-1", role: "user", content: [{ type: "text", text: "go" }] },
      {
        id: "assistant-1",
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call-open",
            name: "bash",
            arguments: { command: "echo hi" },
          },
        ],
      },
    ];
    expect(
      sharedTranscriptItems("shared-session", rows, { turnRunning: false }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "call-open", status: "completed" }),
      ]),
    );
    expect(
      sharedTranscriptItems("shared-session", rows, { turnRunning: true }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "call-open", status: "running" }),
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

  it("does not mark an owned active prompt idle from stale session metadata", () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const session = {
      ...sessionInfoToAgentSession({
        sessionId: "session-1",
        cwd: "/tmp/project",
      }),
      status: "running" as const,
    };
    const internals = controller as unknown as {
      activePromptSessions: Set<string>;
      sessions: Map<string, typeof session>;
      handleSessionUpdate(notification: SessionNotification): void;
    };
    internals.activePromptSessions.add(session.id);
    internals.sessions.set(session.id, session);

    internals.handleSessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { gjcRunning: false },
      },
    });

    expect(internals.sessions.get(session.id)?.status).toBe("running");
    controller.dispose();
  });

  it("announces a turn this window did not start when it goes idle", () => {
    // A steer, or work driven from the terminal, never passes through
    // sendMessage, so its completion has to be announced from the running ->
    // idle transition or the user is never told the run finished.
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const internals = controller as unknown as {
      sessions: Map<string, AgentSession>;
      handleSessionUpdate: (payload: {
        sessionId: string;
        update: Record<string, unknown>;
      }) => void;
    };
    internals.sessions.set("session-1", {
      id: "session-1",
      title: "Chat session",
      subtitle: "project",
      workspace: "/tmp/project",
      runtime: "gjc",
      status: "running",
      updatedAt: "now",
      pinned: false,
      unread: false,
      accent: "#ff8a34",
      ownership: "gajae",
      attachment: "attached",
    });

    internals.handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "session_info_update",
        _meta: { gjcRunning: false },
      },
    });

    const completed = events.filter(
      (event) =>
        event.type === "session.activity" && event.category === "completed",
    );
    expect(completed).toHaveLength(1);
    // The notification names the session, so the event has to carry its title.
    expect(completed[0]).toMatchObject({ title: "Chat session" });
    controller.dispose();
  });

  it("announces an externally owned turn when its transcript goes idle", () => {
    // A terminal-owned session never reaches sendMessage and never emits an ACP
    // session_info_update to this window: it settles through the persisted
    // transcript watcher. Announcing only from those two paths left every run
    // started from the app on such a session finishing silently -- the whole
    // point of the app is that the notification comes from it.
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const internals = controller as unknown as {
      sessions: Map<string, AgentSession>;
      updateSessionStatus: (
        sessionId: string,
        status: AgentSession["status"],
        options?: { announce?: boolean },
      ) => void;
    };
    internals.sessions.set("external-1", {
      ...sessionInfoToAgentSession({
        sessionId: "external-1",
        cwd: "/tmp/project",
      } as never),
      title: "Terminal run",
      status: "running",
    });

    internals.updateSessionStatus("external-1", "idle");

    const completed = events.filter(
      (event) =>
        event.type === "session.activity" && event.category === "completed",
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ title: "Terminal run" });
    controller.dispose();
  });

  it("stays quiet when the user cancels the run themselves", () => {
    // The user performed the cancel and is already looking at the window, so a
    // notification about it is pure noise.
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const internals = controller as unknown as {
      sessions: Map<string, AgentSession>;
      locallyAbortedSessions: Set<string>;
      updateSessionStatus: (
        sessionId: string,
        status: AgentSession["status"],
      ) => void;
    };
    internals.sessions.set("session-1", {
      ...sessionInfoToAgentSession({
        sessionId: "session-1",
        cwd: "/tmp/project",
      } as never),
      status: "running",
    });
    internals.locallyAbortedSessions.add("session-1");

    internals.updateSessionStatus("session-1", "idle");

    expect(
      events.filter(
        (event) =>
          event.type === "session.activity" && event.category === "completed",
      ),
    ).toHaveLength(0);
    controller.dispose();
  });

  it("announces a completed prompt exactly once", async () => {
    // updateSessionStatus announces the transition, so sendMessage must not also
    // announce it: the user would get two cards for one finished turn.
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const extMethod = vi.fn().mockResolvedValue({ ok: true, accepted: true });
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    const internals = controller as unknown as {
      startup: Promise<void>;
      attachedSessions: Set<string>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        prompt: typeof prompt;
      };
    };
    internals.startup = Promise.resolve();
    internals.attachedSessions.add("session-1");
    internals.connection = { signal: { aborted: false }, extMethod, prompt };

    await controller.sendMessage("session-1", {
      text: "한 번만 알려줘",
      images: [],
      files: [],
    });

    expect(
      events.filter(
        (event) =>
          event.type === "session.activity" && event.category === "completed",
      ),
    ).toHaveLength(1);
    controller.dispose();
  });

  it("does not repeat the completion signal while the session stays idle", () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const internals = controller as unknown as {
      sessions: Map<string, AgentSession>;
      handleSessionUpdate: (payload: {
        sessionId: string;
        update: Record<string, unknown>;
      }) => void;
    };
    internals.sessions.set("session-1", {
      id: "session-1",
      title: "Chat session",
      subtitle: "project",
      workspace: "/tmp/project",
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      pinned: false,
      unread: false,
      accent: "#ff8a34",
      ownership: "gajae",
      attachment: "attached",
    });

    for (let index = 0; index < 3; index += 1)
      internals.handleSessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "session_info_update",
          _meta: { gjcRunning: false },
        },
      });

    expect(
      events.filter(
        (event) =>
          event.type === "session.activity" && event.category === "completed",
      ),
    ).toHaveLength(0);
    controller.dispose();
  });

  it("renders a chat prompt as a user bubble before the agent responds", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    let releasePrompt: (() => void) | undefined;
    const prompt = vi.fn().mockImplementation(
      () =>
        new Promise<{ stopReason: string }>((resolve) => {
          releasePrompt = () => resolve({ stopReason: "end_turn" });
        }),
    );
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: { signal: { aborted: boolean }; prompt: typeof prompt };
      attachedSessions: Set<string>;
      sessions: Map<string, unknown>;
      handleSessionUpdate: (payload: unknown) => void;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, prompt };
    internals.attachedSessions.add("session-1");
    internals.sessions.set("session-1", {
      id: "session-1",
      title: "Chat session",
      subtitle: "project",
      workspace: "/tmp/project",
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      pinned: false,
      unread: false,
      accent: "#ff8a34",
    });

    const sent = controller.sendMessage("session-1", {
      text: "Hello there",
      images: [],
      files: [],
    });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());

    const bubbles = () =>
      events
        .filter((event) => event.type === "transcript.appended")
        .map((event) => (event as { item: TranscriptItem }).item)
        .filter(
          (item): item is ChatMessage =>
            item.kind === "message" && item.role === "user",
        );

    // The bubble is visible while the turn is still open, not after it ends.
    expect(bubbles().map((item) => item.content)).toEqual(["Hello there"]);

    // GJC echoes the same prompt back; it must not become a second bubble.
    internals.handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "echo-1",
        content: { type: "text", text: "Hello there" },
      },
    });
    expect(bubbles().map((item) => item.content)).toEqual(["Hello there"]);

    releasePrompt?.();
    await expect(sent).resolves.toBe("prompt");

    // A later identical message is a real new turn and gets its own bubble.
    internals.handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "echo-2",
        content: { type: "text", text: "Hello there" },
      },
    });
    expect(bubbles()).toHaveLength(2);
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
          title: "Notification session",
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

    // The control call resolving only means GJC accepted the request. Compaction
    // is still running, so the progress indicator has to stay up until GJC reports
    // a phase of its own.
    expect(
      (
        controller as unknown as {
          sessions: Map<string, { phase?: string }>;
        }
      ).sessions.get("session-1")?.phase,
    ).toBe("compacting");

    (
      controller as unknown as {
        patchSessionInfo: (id: string, update: unknown) => void;
      }
    ).patchSessionInfo("session-1", {
      sessionUpdate: "session_info_update",
      _meta: { gjcPhase: "idle", gjcRunning: false },
    });

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

  it("explains an uncontrollable session instead of leaking the broker error", async () => {
    // A plain `gjc --resume` in a terminal is alive and heartbeating, so it shows
    // up in the session list, but it never publishes an SDK endpoint. The Router
    // attaches through that endpoint record, so every control operation fails
    // with "unavailable through the session Router" -- which told the user
    // nothing about what to do.
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const session = sessionInfoToAgentSession({
      sessionId: "terminal-session",
      cwd: "/tmp/project",
    } as never);
    const internals = controller as unknown as {
      startup: Promise<void>;
      brokerControl: () => Promise<never>;
      sessions: Map<string, typeof session>;
      terminalOnlySessions: Set<string>;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(session.id, { ...session, status: "idle" });
    internals.brokerControl = () =>
      Promise.reject(
        new Error(
          "SDK session terminal-session is unavailable through the session Router.",
        ),
      );

    await expect(controller.compactSession(session.id)).rejects.toThrow(
      /터미널에서 실행 중인 세션/u,
    );

    // The row stops advertising a control surface it does not have.
    expect(internals.terminalOnlySessions.has(session.id)).toBe(true);
    expect(internals.sessions.get(session.id)?.attachment).toBe(
      "terminal-only",
    );
    // A failed compaction must not leave the session pinned as running, or the
    // composer queues every later message behind a turn that never started.
    expect(internals.sessions.get(session.id)?.status).toBe("idle");
    expect(internals.sessions.get(session.id)?.phase).toBeUndefined();
    controller.dispose();
  });

  it("stops advertising controls on the row after one fails", async () => {
    // Discovery reuses its previous result when broker liveness is unchanged, and
    // proving a session uncontrollable does not change liveness. Without
    // invalidating that reuse the sidebar replayed the snapshot taken before the
    // failure, so the row kept offering compaction that fails every time.
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const session = {
      ...sessionInfoToAgentSession({
        sessionId: "terminal-session",
        cwd: "/tmp/project",
      } as never),
      status: "idle" as const,
    };
    const internals = controller as unknown as {
      startup: Promise<void>;
      brokerControl: () => Promise<never>;
      sessions: Map<string, typeof session>;
      lastDiscovered: Array<typeof session>;
      lastLiveFingerprint: string | undefined;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(session.id, { ...session });
    internals.lastDiscovered = [{ ...session }];
    internals.lastLiveFingerprint = "unchanged-liveness";
    internals.brokerControl = () =>
      Promise.reject(new Error("session_unavailable"));

    expect(internals.lastDiscovered[0]?.attachment).toBe("attachable");
    await expect(controller.compactSession(session.id)).rejects.toThrow();

    expect(internals.lastDiscovered[0]?.attachment).toBe("terminal-only");
    // A stale fingerprint would let the next scan serve the pre-failure snapshot.
    expect(internals.lastLiveFingerprint).toBeUndefined();
    controller.dispose();
  });

  it("keeps a proven-uncontrollable session marked across a rescan", async () => {
    // Discovery re-derives terminal-only from broker liveness. A session that
    // already failed a control operation is proven uncontrollable by evidence the
    // index does not carry, so clearing the set per scan made the row advertise
    // controls that fail again on the next click.
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      terminalOnlySessions: Set<string>;
      brokerSessions: () => Promise<undefined>;
      requireConnection: () => Promise<unknown>;
      discoverSessions: () => Promise<unknown>;
    };
    internals.startup = Promise.resolve();
    internals.requireConnection = () => Promise.resolve({});
    internals.brokerSessions = () => Promise.resolve(undefined);
    internals.terminalOnlySessions.add("terminal-session");

    await internals.discoverSessions();

    expect(internals.terminalOnlySessions.has("terminal-session")).toBe(true);
    controller.dispose();
  });

  it("keeps a running turn running when compaction fails under it", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const session = sessionInfoToAgentSession({
      sessionId: "busy-session",
      cwd: "/tmp/project",
    } as never);
    const internals = controller as unknown as {
      startup: Promise<void>;
      brokerControl: () => Promise<never>;
      sessions: Map<string, typeof session>;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(session.id, { ...session, status: "running" });
    internals.brokerControl = () =>
      Promise.reject(new Error("session_unavailable"));

    await expect(controller.compactSession(session.id)).rejects.toThrow();

    expect(internals.sessions.get(session.id)?.status).toBe("running");
    expect(internals.sessions.get(session.id)?.phase).toBeUndefined();
    controller.dispose();
  });

  it("shows a steer as a user bubble before the control round trip resolves", async () => {
    // Without a local echo the bubble waits for GJC to stream its own
    // user_message_chunk back, which lands seconds later on a busy turn and
    // reads as the composer having swallowed the message.
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    let releaseControl: (() => void) | undefined;
    const extMethod = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseControl = () => resolve({ ok: true, accepted: true });
        }),
    );
    const internals = controller as unknown as {
      brokerControl: () => Promise<undefined>;
      connection: { signal: { aborted: boolean }; extMethod: typeof extMethod };
    };
    internals.brokerControl = vi.fn();
    internals.connection = { signal: { aborted: false }, extMethod };

    const steered = controller.steerSession("session-1", {
      text: "지금 바로 확인해",
      images: [],
      files: [],
    });
    await Promise.resolve();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "transcript.appended",
        item: expect.objectContaining({
          role: "user",
          content: "지금 바로 확인해",
        }),
      }),
    );
    releaseControl?.();
    await steered;
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
  it("interrupts without consulting the remote queue when flushing", async () => {
    // GJC never reports a waiting steer -- turn.steer is consumed by the open turn
    // -- so polling queue.messages.list only delayed the interrupt. The window owns
    // its pending queue and asks for the abort directly.
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const brokerControl = vi.fn();
    let queueListings = 0;
    const extMethod = vi.fn().mockImplementation((_method, params) => {
      if (params.query === "queue.messages.list") {
        queueListings += 1;
        return Promise.resolve({ page: { items: [], complete: true } });
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
    expect(queueListings).toBe(0);
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

  it("steers a composer submission while its prompt is active", async () => {
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
      operation: "turn.steer",
      input: expect.objectContaining({ text: "check the narrower failure" }),
    });
    expect(brokerControl).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("shows a prompt once, swallowing only GJC's echo of it", async () => {
    // The window now echoes a prompt itself and consumes exactly one matching
    // update from GJC. Suppressing user text by matching a durable request log
    // instead made a repeated request disappear for good.
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const extMethod = vi.fn().mockResolvedValue({ ok: true, accepted: true });
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    const internals = controller as unknown as {
      startup: Promise<void>;
      attachedSessions: Set<string>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        prompt: typeof prompt;
      };
      handleSessionUpdate: (payload: {
        sessionId: string;
        update: Record<string, unknown>;
      }) => void;
    };
    internals.startup = Promise.resolve();
    internals.attachedSessions.add("session-1");
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      prompt,
    };

    await controller.sendMessage("session-1", {
      text: "자꾸 말풍선으로 가잖아",
      images: [],
      files: [],
    });
    internals.handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "gjc-user-echo",
        content: { type: "text", text: "자꾸 말풍선으로 가잖아" },
      },
    });

    const bubbles = events.filter(
      (event) =>
        event.type === "transcript.appended" &&
        (event as { item: { role?: string } }).item.role === "user",
    );
    expect(bubbles).toHaveLength(1);
    controller.dispose();
  });

  it("shows an external-session prompt before the broker CLI returns", async () => {
    // An externally owned session sends through a `gjc sdk` spawn that costs
    // seconds. The bubble and the running status must be published first, and
    // the busy fallback must not echo the same text a second time.
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
      sessionMetadata: {} as unknown as SessionMetadataStore,
    });
    let releaseBroker: (() => void) | undefined;
    const brokerControl = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseBroker = () => resolve({ ok: true });
        }),
    );
    const session = sessionInfoToAgentSession({
      sessionId: "external-session",
      cwd: "/tmp/project",
    } as never);
    const internals = controller as unknown as {
      startup: Promise<void>;
      brokerControl: typeof brokerControl;
      sessions: Map<string, typeof session>;
    };
    internals.startup = Promise.resolve();
    internals.brokerControl = brokerControl;
    internals.sessions.set(session.id, session);

    const sent = controller.sendMessage(session.id, {
      text: "새 지시를 바로 보여줘",
      images: [],
      files: [],
    });
    await Promise.resolve();

    const bubbles = events.filter(
      (event) =>
        event.type === "transcript.appended" &&
        (event as { item: { role?: string } }).item.role === "user",
    );
    expect(bubbles).toHaveLength(1);
    expect(internals.sessions.get(session.id)?.status).toBe("running");
    releaseBroker?.();
    await expect(sent).resolves.toBe("prompt");
    controller.dispose();
  });

  it("shows a repeated request as its own bubble", async () => {
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const extMethod = vi.fn().mockResolvedValue({ ok: true, accepted: true });
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    const internals = controller as unknown as {
      startup: Promise<void>;
      attachedSessions: Set<string>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        prompt: typeof prompt;
      };
    };
    internals.startup = Promise.resolve();
    internals.attachedSessions.add("session-1");
    internals.connection = { signal: { aborted: false }, extMethod, prompt };

    for (let index = 0; index < 2; index += 1)
      await controller.sendMessage("session-1", {
        text: "같은 말 또 보냄",
        images: [],
        files: [],
      });

    const bubbles = events.filter(
      (event) =>
        event.type === "transcript.appended" &&
        (event as { item: { role?: string } }).item.role === "user",
    );
    expect(bubbles).toHaveLength(2);
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

  it("steers an ordinary prompt when the remote session became busy without adding a failure notice", async () => {
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
    ).resolves.toBe("steer");

    expect(extMethod).toHaveBeenCalledWith("_gjc/sdk/control", {
      sessionId: session.id,
      operation: "turn.steer",
      input: expect.objectContaining({ text: "focus the active run" }),
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
    ).resolves.toBe("prompt");

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

  it("does not announce a cancellation the persisted transcript already reports", () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      transcripts: Map<string, TranscriptItem[]>;
      appendCancelledNotice: (sessionId: string) => void;
    };
    internals.startup = Promise.resolve();
    // The rebuilt transcript already carries the aborted turn as its own notice.
    internals.transcripts.set("session-1", [
      {
        id: "shared-cancelled-row9",
        kind: "notice",
        sessionId: "session-1",
        title: "작업 취소됨",
        content: "진행 중인 작업이 취소되어 종료됐습니다.",
        tone: "neutral",
        createdAt: "08:50",
      } as unknown as TranscriptItem,
    ]);
    internals.appendCancelledNotice("session-1");
    expect(
      (internals.transcripts.get("session-1") ?? []).filter(
        (item) => item.kind === "notice",
      ),
    ).toHaveLength(1);
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
    expect(brokerControl).not.toHaveBeenCalled();
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

describe("listSessions cursor hygiene", () => {
  it("releases a stranded pagination cursor when a scan cannot finish", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    // Page 1 hands out a cursor, page 2 fails. The broker holds only 32 cursors
    // for 15 minutes, so abandoning this one degrades session.list process-wide.
    const seen: Array<string | undefined> = [];
    let failNext = false;
    const extMethod = vi.fn().mockImplementation((_method, params) => {
      const input = (params as { input?: Record<string, unknown> }).input ?? {};
      const cursor =
        typeof input.cursor === "string" ? input.cursor : undefined;
      seen.push(cursor);
      if (cursor === undefined) {
        failNext = true;
        return Promise.resolve({
          result: { sessions: [], continuationCursor: "cursor-1" },
        });
      }
      if (failNext) {
        failNext = false;
        return Promise.resolve({
          ok: false,
          error: { code: "unavailable", message: "broker restarting" },
        });
      }
      return Promise.resolve({ result: { sessions: [] } });
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        listSessions: ReturnType<typeof vi.fn>;
      };
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    };

    await controller.listSessions();

    // The cursor must be walked again to release it rather than left to expire.
    expect(seen.filter((entry) => entry === "cursor-1").length).toBeGreaterThan(
      1,
    );
    controller.dispose();
  });
});

describe("listSessions broker index failure", () => {
  it("keeps the previous list when the broker index cannot be read", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    let brokerOk = true;
    const extMethod = vi.fn().mockImplementation(() =>
      Promise.resolve(
        brokerOk
          ? {
              result: {
                sessions: [
                  {
                    sessionId: "alive",
                    live: true,
                    endpointGeneration: 1,
                    locator: { repo: "/tmp/project" },
                  },
                  {
                    sessionId: "dead",
                    live: false,
                    endpointGeneration: 1,
                    locator: { repo: "/tmp/project" },
                  },
                ],
              },
            }
          : {
              ok: false,
              error: {
                code: "invalid_input",
                message: "session.list cursor capacity is exhausted",
              },
            },
      ),
    );
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [
        { sessionId: "alive", cwd: "/tmp/project", title: "Alive" },
        { sessionId: "dead", cwd: "/tmp/project", title: "Dead" },
      ],
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        listSessions: typeof listSessions;
      };
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      listSessions,
    };

    await expect(controller.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: "alive" }),
    ]);

    // The index is the only source of liveness. A failed read must not be taken
    // as "nothing is dead", which would republish every historical session.
    brokerOk = false;
    (
      controller as unknown as { lastLiveFingerprint?: string }
    ).lastLiveFingerprint = undefined;
    await expect(controller.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: "alive" }),
    ]);
    controller.dispose();
  });
});

describe("listSessions scan reuse", () => {
  const liveBroker = () => ({
    result: {
      sessions: [
        {
          sessionId: "alive",
          live: true,
          endpointGeneration: 1,
          locator: { repo: "/tmp/project" },
        },
      ],
    },
  });

  it("skips the per-workspace listing when the live set is unchanged", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const extMethod = vi.fn().mockResolvedValue(liveBroker());
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [{ sessionId: "alive", cwd: "/tmp/project", title: "Alive" }],
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        listSessions: typeof listSessions;
      };
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      listSessions,
    };

    await expect(controller.listSessions()).resolves.toHaveLength(1);
    expect(listSessions).toHaveBeenCalledTimes(1);

    // Nothing about the live set changed, so the expensive stage is not repeated.
    await expect(controller.listSessions()).resolves.toHaveLength(1);
    expect(listSessions).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("rescans when a new live session appears", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    let broker = liveBroker();
    const extMethod = vi.fn().mockImplementation(() => Promise.resolve(broker));
    const listSessions = vi.fn().mockImplementation(() =>
      Promise.resolve({
        sessions: broker.result.sessions.map((entry) => ({
          sessionId: entry.sessionId,
          cwd: "/tmp/project",
          title: entry.sessionId,
        })),
      }),
    );
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        listSessions: typeof listSessions;
      };
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      listSessions,
    };

    await expect(controller.listSessions()).resolves.toHaveLength(1);
    broker = {
      result: {
        sessions: [
          ...liveBroker().result.sessions,
          {
            sessionId: "cli-new",
            live: true,
            endpointGeneration: 1,
            locator: { repo: "/tmp/project" },
          },
        ],
      },
    };
    await expect(controller.listSessions()).resolves.toHaveLength(2);
    expect(listSessions).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});

describe("listSessions yield fidelity", () => {
  it("does not resurrect filtered sessions while yielding to a live turn", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const extMethod = vi.fn().mockResolvedValue({
      result: {
        sessions: [
          {
            sessionId: "alive",
            live: true,
            endpointGeneration: 1,
            locator: { repo: "/tmp/project" },
          },
          {
            sessionId: "dead",
            live: false,
            endpointGeneration: 1,
            locator: { repo: "/tmp/project" },
          },
        ],
      },
    });
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [
        { sessionId: "alive", cwd: "/tmp/project", title: "Alive" },
        { sessionId: "dead", cwd: "/tmp/project", title: "Dead" },
      ],
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      activePromptSessions: Set<string>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        listSessions: typeof listSessions;
      };
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      listSessions,
    };

    await expect(controller.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: "alive" }),
    ]);

    // The session map still holds "dead" as a cache entry, so yielding must
    // replay the filtered result rather than dumping that map.
    internals.activePromptSessions.add("alive");
    await expect(controller.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: "alive" }),
    ]);
    controller.dispose();
  });
});

describe("listSessions channel contention", () => {
  it("yields discovery while the user's own turn is in flight", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const extMethod = vi.fn();
    const listSessions = vi.fn();
    const internals = controller as unknown as {
      startup: Promise<void>;
      activePromptSessions: Set<string>;
      sessions: Map<string, unknown>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        listSessions: typeof listSessions;
      };
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      listSessions,
    };
    // Yielding replays the previous scan, so seed one instead of the raw cache.
    (controller as unknown as { lastDiscovered: unknown[] }).lastDiscovered = [
      {
        id: "session-1",
        title: "Busy",
        workspace: "/tmp/project",
        status: "running",
        unread: false,
      },
    ];
    internals.activePromptSessions.add("session-1");

    // A full scan costs many round trips on the one ACP channel the prompt uses.
    await expect(controller.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: "session-1" }),
    ]);
    expect(extMethod).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("collapses overlapping discovery into one scan", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const extMethod = vi.fn().mockResolvedValue({ result: { sessions: [] } });
    const listSessions = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ sessions: [] }), 10),
          ),
      );
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        listSessions: typeof listSessions;
      };
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      listSessions,
    };

    // A slow scan plus a 15s poll must not stack overlapping scans.
    await Promise.all([
      controller.listSessions(),
      controller.listSessions(),
      controller.listSessions(),
    ]);
    expect(listSessions).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});

describe("listSessions dead session pruning", () => {
  it("omits dead broker session ids instead of listing empty rows", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const alive = {
      sessionId: "alive",
      cwd: "/tmp/project",
      title: "Alive",
    };
    const dead = { sessionId: "dead", cwd: "/tmp/project", title: "Dead" };
    const extMethod = vi.fn().mockResolvedValue({
      result: {
        sessions: [
          {
            sessionId: "alive",
            live: true,
            endpointGeneration: 1,
            locator: { repo: "/tmp/project" },
          },
          {
            sessionId: "dead",
            live: false,
            endpointGeneration: 1,
            locator: { repo: "/tmp/project" },
          },
        ],
      },
    });
    const listSessions = vi.fn().mockResolvedValue({ sessions: [alive, dead] });
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        listSessions: typeof listSessions;
      };
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      listSessions,
    };

    await expect(controller.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: "alive" }),
    ]);
    controller.dispose();
  });
});

describe("listSessions discovery reach", () => {
  it("lists a live CLI session from a workspace this app never opened", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const foreign = {
      sessionId: "cli-session",
      cwd: "/tmp/elsewhere",
      title: "CLI session",
    };
    const extMethod = vi.fn().mockResolvedValue({
      result: {
        sessions: [
          {
            sessionId: "cli-session",
            live: true,
            endpointGeneration: 1,
            pid: 4321,
            locator: { repo: "/tmp/elsewhere" },
          },
        ],
      },
    });
    const listSessions = vi.fn().mockImplementation((input: { cwd: string }) =>
      Promise.resolve({
        sessions: input.cwd === "/tmp/elsewhere" ? [foreign] : [],
      }),
    );
    const internals = controller as unknown as {
      startup: Promise<void>;
      connection: {
        signal: { aborted: boolean };
        extMethod: typeof extMethod;
        listSessions: typeof listSessions;
      };
    };
    internals.startup = Promise.resolve();
    internals.connection = {
      signal: { aborted: false },
      extMethod,
      listSessions,
    };

    await expect(controller.listSessions()).resolves.toEqual([
      expect.objectContaining({
        id: "cli-session",
        workspace: "/tmp/elsewhere",
      }),
    ]);
    expect(listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/elsewhere" }),
    );
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
      ),
    ).toBe(true);
    expect(
      isControllerSession(
        { repo: "/tmp/project", endpointGeneration: 2, pid: 99 },
        42,
      ),
    ).toBe(false);
  });

  it("filters non-attachable control placeholders in every repository", () => {
    expect(
      isControllerSession({ repo: "/tmp/project", endpointGeneration: 0 }, 42),
    ).toBe(true);
    // Discovery reaches other repositories now, and their placeholders carry no
    // transcript either, so they must not reach the session list.
    expect(
      isControllerSession({ repo: "/tmp/other", endpointGeneration: 0 }, 42),
    ).toBe(true);
    expect(
      isControllerSession({ repo: "/tmp/other", endpointGeneration: 1 }, 42),
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

  it("opens a past session that discovery no longer lists", async () => {
    // Discovery drops sessions the broker stopped reporting as live, so the only
    // way back to them is the session file -- which is what `gjc --resume <id>`
    // uses. Opening one must create the row and attach it.
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      sessions: Map<string, AgentSession>;
      connection: Record<string, unknown>;
      locateSharedTranscriptFile: (id: string) => Promise<string | undefined>;
      refreshSessionSettings: (id: string) => Promise<void>;
      refreshModelProfiles: (id: string) => Promise<void>;
      refreshContextUsage: (id: string) => Promise<void>;
      getTranscript: (id: string) => Promise<TranscriptItem[]>;
    };
    internals.startup = Promise.resolve();
    const file = path.join(
      await mkdtemp(path.join(tmpdir(), "gajae-history-")),
      "2026-08-01T00-00-00-000Z_past-session.jsonl",
    );
    await writeFile(
      file,
      [
        JSON.stringify({ type: "session", cwd: "/tmp/recovered" }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "go" }] },
        }),
      ].join("\n"),
    );
    internals.locateSharedTranscriptFile = async () => file;
    internals.connection = {
      signal: { aborted: false },
      loadSession: vi.fn().mockResolvedValue({ configOptions: [] }),
    };
    internals.refreshSessionSettings = async () => undefined;
    internals.refreshModelProfiles = async () => undefined;
    internals.refreshContextUsage = async () => undefined;
    internals.getTranscript = async () => [];

    await expect(
      controller.openHistorySession("past-session"),
    ).resolves.toMatchObject({
      id: "past-session",
      // The workspace comes from the session file, not this window's default.
      workspace: "/tmp/recovered",
      attachment: "attached",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.created",
        session: expect.objectContaining({ id: "past-session" }),
      }),
    );
    controller.dispose();
  });

  it("re-attaches a terminal-only session and republishes its transcript", async () => {
    // terminal-only and recovering are dead ends: the transcript is readable but
    // nothing can be sent. The refusal is not permanent, so an explicit resume
    // clears the flag and attaches again.
    const events: AgentEvent[] = [];
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: (event) => events.push(event),
    });
    const session = sessionInfoToAgentSession({
      sessionId: "stuck-session",
      cwd: "/tmp/project",
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      sessions: Map<string, typeof session>;
      sessionCwds: Map<string, string>;
      terminalOnlySessions: Set<string>;
      attachedSessions: Set<string>;
      connection: Record<string, unknown>;
      refreshSessionSettings: (id: string) => Promise<void>;
      refreshModelProfiles: (id: string) => Promise<void>;
      refreshContextUsage: (id: string) => Promise<void>;
      getTranscript: (id: string) => Promise<TranscriptItem[]>;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(session.id, {
      ...session,
      attachment: "terminal-only",
      ownership: "external",
      status: "failed",
    });
    internals.sessionCwds.set(session.id, "/tmp/project");
    internals.terminalOnlySessions.add(session.id);
    internals.connection = {
      signal: { aborted: false },
      loadSession: vi.fn().mockResolvedValue({ configOptions: [] }),
    };
    internals.refreshSessionSettings = async () => undefined;
    internals.refreshModelProfiles = async () => undefined;
    internals.refreshContextUsage = async () => undefined;
    internals.getTranscript = async () => [];

    await expect(controller.resumeSession(session.id)).resolves.toMatchObject({
      id: session.id,
      attachment: "attached",
      status: "idle",
    });
    expect(internals.terminalOnlySessions.has(session.id)).toBe(false);
    expect(internals.attachedSessions.has(session.id)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "transcript.synced",
        sessionId: session.id,
      }),
    );
    controller.dispose();
  });

  it("keeps a resumed session usable when its lifecycle receipt cannot be verified", async () => {
    // The receipt records that the attach happened; it does not decide whether it
    // did. The transcript comes from the session file either way, so an
    // unverifiable receipt must not fail the resume outright.
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const session = sessionInfoToAgentSession({
      sessionId: "uncertain-session",
      cwd: "/tmp/project",
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      sessions: Map<string, typeof session>;
      sessionCwds: Map<string, string>;
      terminalOnlySessions: Set<string>;
      connection: Record<string, unknown>;
      refreshModelProfiles: (id: string) => Promise<void>;
      refreshContextUsage: (id: string) => Promise<void>;
      getTranscript: (id: string) => Promise<TranscriptItem[]>;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(session.id, session);
    internals.sessionCwds.set(session.id, "/tmp/project");
    internals.connection = {
      signal: { aborted: false },
      loadSession: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Internal error: Lifecycle terminal evidence could not be verified after persistence; retained artifacts require reconciliation.",
          ),
        ),
    };
    internals.refreshModelProfiles = async () => undefined;
    internals.refreshContextUsage = async () => undefined;
    internals.getTranscript = async () => [];

    await expect(controller.resumeSession(session.id)).resolves.toMatchObject({
      id: session.id,
      // Live control is not guaranteed, so the row says so rather than claiming
      // it is attached.
      attachment: "recovering",
    });
    // A receipt problem is not a lease conflict, so the session is not demoted to
    // read-only terminal ownership.
    expect(internals.terminalOnlySessions.has(session.id)).toBe(false);
    controller.dispose();
  });

  it("reports the holding terminal when a resume is refused", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const session = sessionInfoToAgentSession({
      sessionId: "leased-session",
      cwd: "/tmp/project",
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      sessions: Map<string, typeof session>;
      sessionCwds: Map<string, string>;
      terminalOnlySessions: Set<string>;
      connection: Record<string, unknown>;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(session.id, session);
    internals.sessionCwds.set(session.id, "/tmp/project");
    internals.connection = {
      signal: { aborted: false },
      loadSession: vi
        .fn()
        .mockRejectedValue(new Error("provider_lease_conflict")),
    };

    await expect(controller.resumeSession(session.id)).rejects.toThrow(
      /다른 터미널이 이 세션을 잡고 있어/u,
    );
    // The refusal is recorded so the window keeps showing read-only sync.
    expect(internals.terminalOnlySessions.has(session.id)).toBe(true);
    expect(internals.sessions.get(session.id)?.attachment).toBe(
      "terminal-only",
    );
    controller.dispose();
  });

  it("adopts the forked session when its lifecycle receipt cannot be verified", async () => {
    // The fork creates the session; the receipt is only evidence it was recorded.
    // An unverifiable receipt was surfaced as a failed fork even though the
    // broker had already created the session, so the error showed up and the
    // fork appeared in the sidebar moments later anyway.
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
      .mockRejectedValue(
        new Error(
          "Internal error: Lifecycle terminal evidence could not be verified after persistence; retained artifacts require reconciliation.",
        ),
      );
    const loadSession = vi.fn().mockResolvedValue({ configOptions: [] });
    let listed = false;
    const extMethod = vi.fn().mockImplementation(async () => {
      // The broker only reports the forked session on a later poll.
      if (!listed) {
        listed = true;
        return { ok: true, sessions: [] };
      }
      return {
        ok: true,
        sessions: [
          {
            sessionId: "fork-session",
            locator: { repo: "/tmp/project" },
            live: true,
            endpointGeneration: 3,
          },
        ],
      };
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      sessions: Map<string, typeof source>;
      sessionCwds: Map<string, string>;
      attachedSessions: Set<string>;
      connection: Record<string, unknown>;
      forkRecoveryIntervalMs: number;
    };
    internals.startup = Promise.resolve();
    internals.forkRecoveryIntervalMs = 0;
    internals.sessions.set(source.id, source);
    internals.sessionCwds.set(source.id, "/tmp/project");
    internals.attachedSessions.add(source.id);
    internals.connection = {
      signal: { aborted: false },
      unstable_forkSession: unstableForkSession,
      loadSession,
      extMethod,
    };

    await expect(
      controller.forkSession({ sourceSessionId: source.id }),
    ).resolves.toMatchObject({
      id: "fork-session",
      ownership: "gajae",
      workspace: "/tmp/project",
    });
    expect(loadSession).toHaveBeenCalledWith({
      sessionId: "fork-session",
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

  it("reports an unrecoverable fork instead of inventing a session", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const source = sessionInfoToAgentSession({
      sessionId: "source-session",
      cwd: "/tmp/project",
      title: "Source",
    });
    const internals = controller as unknown as {
      startup: Promise<void>;
      sessions: Map<string, typeof source>;
      sessionCwds: Map<string, string>;
      attachedSessions: Set<string>;
      connection: Record<string, unknown>;
      recoverForkedSession: () => Promise<undefined>;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(source.id, source);
    internals.sessionCwds.set(source.id, "/tmp/project");
    internals.attachedSessions.add(source.id);
    internals.connection = {
      signal: { aborted: false },
      unstable_forkSession: vi
        .fn()
        .mockRejectedValue(
          new Error("retained artifacts require reconciliation"),
        ),
    };
    // No new session ever appears, so the fork really did not happen.
    internals.recoverForkedSession = async () => undefined;

    await expect(
      controller.forkSession({ sourceSessionId: source.id }),
    ).rejects.toThrow(/lifecycle ledger reconciliation/u);
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

describe("persistedTranscriptRunning mid-turn activity", () => {
  it("stays running when the newest rows are a tool call the request has outrun", () => {
    // The reply to a new request reached disk before the request row did, so the
    // last user row still points at the previous turn while the newest rows are
    // mid-turn. Comparing only user against terminal-assistant read this as
    // finished, which showed a working session as complete.
    expect(
      persistedTranscriptRunning([
        { type: "message", message: { role: "user", content: "earlier" } },
        {
          type: "message",
          message: { role: "assistant", stopReason: "stop", content: "done" },
        },
        {
          type: "message",
          message: { role: "assistant", stopReason: "toolUse" },
        },
      ]),
    ).toBe(true);
  });

  it("stays running while a tool result is the newest row", () => {
    expect(
      persistedTranscriptRunning([
        { type: "message", message: { role: "user", content: "earlier" } },
        {
          type: "message",
          message: { role: "assistant", stopReason: "stop", content: "done" },
        },
        {
          type: "message",
          message: { role: "assistant", stopReason: "toolUse" },
        },
        { type: "toolResult", output: "ok" },
      ]),
    ).toBe(true);
  });

  it("settles once a terminal stop reason follows the mid-turn rows", () => {
    expect(
      persistedTranscriptRunning([
        { type: "message", message: { role: "user", content: "work" } },
        {
          type: "message",
          message: { role: "assistant", stopReason: "toolUse" },
        },
        { type: "toolResult", output: "ok" },
        {
          type: "message",
          message: { role: "assistant", stopReason: "end_turn", content: "y" },
        },
      ]),
    ).toBe(false);
  });
});

describe("session status authority", () => {
  it("keeps a live running signal when a lagging transcript still reads idle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gjc-status-"));
    const file = path.join(root, "session.jsonl");
    // The turn started, so the live signal says running. The persisted transcript
    // has not flushed the new user row yet, so on its own it reads idle.
    await writeFile(
      file,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: "first" },
      })}\n${JSON.stringify({
        type: "message",
        message: { role: "assistant", stopReason: "end_turn", content: "done" },
      })}\n`,
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
      sessions: Map<string, typeof session>;
      locateSharedTranscriptFile: (id: string) => Promise<string | undefined>;
      readPersistedTranscript: (id: string) => Promise<unknown>;
      patchSessionInfo: (id: string, update: unknown) => void;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(session.id, session);
    internals.locateSharedTranscriptFile = async () => file;

    // A terminal-driven turn: the live signal is the only thing that knows.
    internals.patchSessionInfo(session.id, {
      sessionUpdate: "session_info_update",
      _meta: { gjcRunning: true },
    });
    expect(internals.sessions.get(session.id)?.status).toBe("running");

    await internals.readPersistedTranscript(session.id);

    expect(internals.sessions.get(session.id)?.status).toBe("running");
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a finished turn reported for a prompt this window sent", async () => {
    const controller = new GjcAcpController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const session = sessionInfoToAgentSession({
      sessionId: "session-1",
      cwd: "/tmp/project",
    });
    const internals = controller as unknown as {
      sessions: Map<string, typeof session>;
      activePromptSessions: Set<string>;
      patchSessionInfo: (id: string, update: unknown) => void;
    };
    internals.sessions.set(session.id, session);
    internals.activePromptSessions.add(session.id);
    internals.patchSessionInfo(session.id, {
      sessionUpdate: "session_info_update",
      _meta: { gjcRunning: true },
    });

    internals.patchSessionInfo(session.id, {
      sessionUpdate: "session_info_update",
      _meta: { gjcRunning: false },
    });

    expect(internals.sessions.get(session.id)?.status).toBe("idle");
    controller.dispose();
  });

  it("releases the compacting phase from the transcript for a terminal-owned session", async () => {
    // A terminal-owned session never receives session_info_update, so the live
    // signal cannot release the phase. Its transcript records the finished
    // compaction, and that record is the evidence.
    const root = await mkdtemp(path.join(tmpdir(), "gjc-compact-"));
    const file = path.join(root, "session.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: "before" },
      })}\n${JSON.stringify({
        type: "message",
        message: { role: "assistant", stopReason: "end_turn", content: "ok" },
      })}\n`,
    );
    const extMethod = vi
      .fn()
      .mockImplementation((_method: string, params: { operation?: string }) => {
        if (params.operation === "compaction.run")
          return Promise.resolve({ ok: true, accepted: true });
        return Promise.resolve({ page: { items: [] } });
      });
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
      terminalOnlySessions: Set<string>;
      locateSharedTranscriptFile: (id: string) => Promise<string | undefined>;
      readPersistedTranscript: (id: string) => Promise<unknown>;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, extMethod };
    internals.sessions.set(session.id, session);
    internals.terminalOnlySessions.add(session.id);
    internals.locateSharedTranscriptFile = async () => file;

    await controller.compactSession(session.id);
    expect(internals.sessions.get(session.id)?.phase).toBe("compacting");

    // GJC finishes and records the compaction in the transcript.
    await writeFile(
      file,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: "before" },
      })}\n${JSON.stringify({
        type: "message",
        message: { role: "assistant", stopReason: "end_turn", content: "ok" },
      })}\n${JSON.stringify({
        type: "compaction",
        id: "c1",
        timestamp: new Date().toISOString(),
        summary: "compacted",
      })}\n`,
    );
    await internals.readPersistedTranscript(session.id);

    expect(internals.sessions.get(session.id)?.phase).toBeUndefined();
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("does not treat an earlier compaction as the one just requested", async () => {
    // A long session has compacted before. Counting records without a baseline
    // made the very first transcript read look like the new compaction had
    // finished, so the indicator vanished immediately.
    const root = await mkdtemp(path.join(tmpdir(), "gjc-compact-base-"));
    const file = path.join(root, "session.jsonl");
    const history = `${JSON.stringify({
      type: "compaction",
      id: "old",
      timestamp: "2026-08-01T00:00:00.000Z",
      summary: "an earlier compaction",
    })}\n${JSON.stringify({
      type: "message",
      message: { role: "user", content: "after the old compaction" },
    })}\n${JSON.stringify({
      type: "message",
      message: { role: "assistant", stopReason: "end_turn", content: "ok" },
    })}\n`;
    await writeFile(file, history);
    const extMethod = vi
      .fn()
      .mockImplementation((_method: string, params: { operation?: string }) => {
        if (params.operation === "compaction.run")
          return Promise.resolve({ ok: true, accepted: true });
        return Promise.resolve({ page: { items: [] } });
      });
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
      terminalOnlySessions: Set<string>;
      locateSharedTranscriptFile: (id: string) => Promise<string | undefined>;
      readPersistedTranscript: (id: string) => Promise<unknown>;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, extMethod };
    internals.sessions.set(session.id, session);
    internals.terminalOnlySessions.add(session.id);
    internals.locateSharedTranscriptFile = async () => file;

    await controller.compactSession(session.id);
    await internals.readPersistedTranscript(session.id);

    // The old record must not be mistaken for the requested compaction.
    expect(internals.sessions.get(session.id)?.phase).toBe("compacting");

    await writeFile(
      file,
      `${history}${JSON.stringify({
        type: "compaction",
        id: "new",
        timestamp: new Date().toISOString(),
        summary: "the requested compaction",
      })}\n`,
    );
    await internals.readPersistedTranscript(session.id);

    expect(internals.sessions.get(session.id)?.phase).toBeUndefined();
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("settles a terminal-owned turn the transcript reports finished", async () => {
    // The live signal marks the session running, then the terminal finishes the
    // turn. A terminal-owned session receives no gjcRunning:false, so if the live
    // flag is only cleared by that report the row stays running forever even
    // though the transcript states the turn ended.
    const root = await mkdtemp(path.join(tmpdir(), "gjc-stuck-"));
    const file = path.join(root, "session.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: "work" },
      })}\n`,
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
      sessions: Map<string, typeof session>;
      terminalOnlySessions: Set<string>;
      locateSharedTranscriptFile: (id: string) => Promise<string | undefined>;
      readPersistedTranscript: (id: string) => Promise<unknown>;
      patchSessionInfo: (id: string, update: unknown) => void;
    };
    internals.startup = Promise.resolve();
    internals.sessions.set(session.id, session);
    internals.terminalOnlySessions.add(session.id);
    internals.locateSharedTranscriptFile = async () => file;

    internals.patchSessionInfo(session.id, {
      sessionUpdate: "session_info_update",
      _meta: { gjcRunning: true },
    });
    expect(internals.sessions.get(session.id)?.status).toBe("running");

    // The turn finishes and the transcript records the terminal stop reason.
    await writeFile(
      file,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: "work" },
      })}\n${JSON.stringify({
        type: "message",
        message: { role: "assistant", stopReason: "end_turn", content: "done" },
      })}\n`,
    );
    await internals.readPersistedTranscript(session.id);

    expect(internals.sessions.get(session.id)?.status).toBe("idle");
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("holds the compacting phase until compaction is actually finished", async () => {
    const extMethod = vi
      .fn()
      .mockImplementation((_method: string, params: { operation?: string }) => {
        if (params.operation === "compaction.run")
          return Promise.resolve({ ok: true, accepted: true });
        return Promise.resolve({ page: { items: [] } });
      });
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
      patchSessionInfo: (id: string, update: unknown) => void;
    };
    internals.startup = Promise.resolve();
    internals.connection = { signal: { aborted: false }, extMethod };
    internals.sessions.set(session.id, session);

    await controller.compactSession(session.id);

    // The control call only means the request was accepted. GJC is still
    // compacting until it says otherwise, so the phase must survive the return.
    expect(internals.sessions.get(session.id)?.phase).toBe("compacting");

    internals.patchSessionInfo(session.id, {
      sessionUpdate: "session_info_update",
      _meta: { gjcPhase: "idle", gjcRunning: false },
    });

    expect(internals.sessions.get(session.id)?.phase).toBeUndefined();
    controller.dispose();
  });
});
