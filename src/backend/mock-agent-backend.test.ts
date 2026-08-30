import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgentBackend } from "./mock-agent-backend";
import type { AgentEvent } from "./types";

describe("MockAgentBackend", () => {
  let backend: MockAgentBackend;

  beforeEach(() => {
    vi.useFakeTimers();
    backend = new MockAgentBackend();
  });

  afterEach(() => {
    backend.dispose();
    vi.useRealTimers();
  });

  it("provides isolated session and transcript snapshots", async () => {
    const firstSessions = await backend.listSessions();
    const secondSessions = await backend.listSessions();
    expect(firstSessions).not.toBe(secondSessions);
    expect(firstSessions[0]).not.toBe(secondSessions[0]);

    const firstTranscript = await backend.getTranscript("agent-control");
    const secondTranscript = await backend.getTranscript("agent-control");
    expect(firstTranscript).not.toBe(secondTranscript);
    expect(firstTranscript[0]).not.toBe(secondTranscript[0]);
  });

  it("creates runtime-neutral sessions and emits creation events", async () => {
    const events: AgentEvent[] = [];
    backend.subscribe((event) => events.push(event));

    const session = await backend.createSession({
      runtime: "hermes",
      title: "Daily brief",
      workspace: "/tmp/daily",
      isolation: "workspace",
    });

    expect(session).toMatchObject({
      title: "Daily brief",
      runtime: "hermes",
      status: "idle",
    });
    expect(events).toEqual([{ type: "session.created", session }]);
    expect(await backend.getTranscript(session.id)).toEqual([]);
  });

  it("streams a mock reply and returns the session to idle", async () => {
    const events: AgentEvent[] = [];
    backend.subscribe((event) => events.push(event));

    await backend.sendMessage("agent-control", {
      text: "Connect the runtime",
      images: [],
      files: [],
    });
    await vi.runAllTimersAsync();

    const transcript = await backend.getTranscript("agent-control");
    expect(transcript.at(-2)).toMatchObject({
      kind: "message",
      role: "user",
      content: "Connect the runtime",
    });
    expect(transcript.at(-1)).toMatchObject({
      kind: "message",
      role: "assistant",
      content: expect.stringContaining("GJC ACP"),
      streaming: false,
    });
    expect(events.some((event) => event.type === "message.delta")).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.updated",
        session: expect.objectContaining({ status: "idle" }),
      }),
    );
  });

  it("keeps image attachments in the visible user transcript", async () => {
    await backend.sendMessage("agent-control", {
      text: "Inspect this screenshot",
      images: [
        {
          id: "image-1",
          name: "screen.png",
          mimeType: "image/png",
          token: "image-capability",
          data: "aW1hZ2U=",
        },
      ],
      files: [],
    });

    const transcript = await backend.getTranscript("agent-control");
    expect(transcript.at(-1)).toMatchObject({
      kind: "message",
      role: "user",
      images: [{ name: "screen.png", mimeType: "image/png" }],
    });
  });

  it("cancels scheduled output and resolves approval requests", async () => {
    const events: AgentEvent[] = [];
    backend.subscribe((event) => events.push(event));

    await backend.sendMessage("agent-control", {
      text: "Stop this run",
      images: [],
      files: [],
    });
    await backend.cancelRun("agent-control");
    await vi.runAllTimersAsync();

    const transcript = await backend.getTranscript("agent-control");
    expect(
      transcript.some(
        (item) => item.kind === "message" && item.content === "Stop this run",
      ),
    ).toBe(true);
    expect(
      transcript.some(
        (item) =>
          item.kind === "message" &&
          item.role === "assistant" &&
          item.createdAt === "now",
      ),
    ).toBe(false);

    await backend.resolveToolCall("tool-approval-1", {
      optionId: "allow_once",
    });
    expect(events.at(-1)).toMatchObject({
      type: "tool.updated",
      tool: {
        id: "tool-approval-1",
        status: "approved",
        output: "Approved for this run",
      },
    });
  });

  it("renames and deletes sessions through observable events", async () => {
    const events: AgentEvent[] = [];
    backend.subscribe((event) => events.push(event));

    await backend.renameSession("agent-control", "Renamed agent");
    expect(events.at(-1)).toMatchObject({
      type: "session.updated",
      session: { id: "agent-control", title: "Renamed agent" },
    });

    await backend.deleteSession("agent-control");
    expect(events.at(-1)).toEqual({
      type: "session.deleted",
      sessionId: "agent-control",
    });
    expect(
      (await backend.listSessions()).some(
        (session) => session.id === "agent-control",
      ),
    ).toBe(false);
  });

  it("exposes deterministic fork parent context", async () => {
    const fork = await backend.forkSession({
      sourceSessionId: "agent-control",
      title: "Forked",
    });
    expect(fork.title).toBe("Forked");
    expect((await backend.getTranscript(fork.id)).at(-1)).toMatchObject({
      kind: "notice",
      content: expect.stringContaining("agent-control"),
    });
  });

  it("transitions mock git state and keeps file attachments visible", async () => {
    await backend.sendMessage("agent-control", {
      text: "Review files",
      images: [],
      files: [
        {
          id: "f1",
          name: "notes.txt",
          mimeType: "text/plain",
          size: 4,
          token: "file-capability",
        },
      ],
    });
    expect((await backend.getTranscript("agent-control")).at(-1)).toMatchObject(
      { content: expect.stringContaining("notes.txt") },
    );
    await backend.stageFiles("agent-control", ["README.md"]);
    expect(
      (await backend.getGitStatus("agent-control")).files[0],
    ).toMatchObject({ index: "M" });
    await backend.commitChanges("agent-control", "save");
    expect((await backend.getGitStatus("agent-control")).ahead).toBe(1);
    expect((await backend.pushChanges("agent-control")).ahead).toBe(0);
  });
});
