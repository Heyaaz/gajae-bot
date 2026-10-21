import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GjcSdkController } from "./gjc-sdk-controller.js";
import type { TranscriptPage } from "../shared/agent-contract.js";
import type { IpcSecurity } from "./ipc-security.js";
import { GJC_IPC } from "../shared/gjc-ipc.js";
import { AttachmentStore } from "./attachment-store.js";
import {
  messageInput,
  registerGjcIpcHandlers,
  withResolvedMessageInput,
} from "./gjc-ipc-handlers.js";

const handled = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handled.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handled.delete(channel);
    },
  },
}));

const roots: string[] = [];

async function nativeFile() {
  const root = await mkdtemp(path.join(tmpdir(), "gajae-attachment-ipc-"));
  roots.push(root);
  const file = path.join(root, "note.txt");
  await writeFile(file, "hello");
  const info = await stat(file);
  return {
    file,
    metadata: {
      name: "note.txt",
      mimeType: "text/plain",
      size: info.size,
      mtimeMs: info.mtimeMs,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("destructive message policy", () => {
  function setup(confirmation: "allow" | "deny" = "allow") {
    const send = vi.fn().mockResolvedValue("prompt");
    const confirm = vi
      .fn()
      .mockImplementation(async () => {
        if (confirmation === "deny") throw new Error("cancelled");
      });
    const guarded = vi.fn(
      (handler: (...args: unknown[]) => unknown) =>
        async (...args: unknown[]) => handler(...args),
    );
    registerGjcIpcHandlers(
      { sendMessage: send } as unknown as GjcSdkController,
      new AttachmentStore(),
      {
        guarded,
        owner: vi.fn(),
        authorizeDestructive: confirm,
      } as unknown as IpcSecurity,
    );
    return { send, confirm };
  }

  it("confirms the slash form of deletion before sending it", async () => {
    const { send, confirm } = setup();
    const event = { sender: { id: 7 } };
    await handled.get(GJC_IPC.sendMessage)!(event, "session-a", {
      text: "/session delete",
      images: [],
      files: [],
    });
    // The same question the explicit delete action asks.
    expect(confirm).toHaveBeenCalledExactlyOnceWith(event, {
      message: "세션을 삭제할까요?",
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "session-a",
      { text: "/session delete", images: [], files: [] },
      { allowDestructive: true },
    );
  });

  it("asks the matching question for compact and goal termination", async () => {
    const { send, confirm } = setup();
    const event = { sender: { id: 7 } };
    for (const [text, message] of [
      ["/compact", "이 세션을 압축할까요? 대화 기록이 다시 작성됩니다."],
      ["/goal complete", "이 목표를 완료로 표시할까요?"],
      ["/goal drop", "이 목표를 삭제할까요?"],
    ] as const) {
      await handled.get(GJC_IPC.sendMessage)!(event, "session-a", {
        text,
        images: [],
        files: [],
      });
      expect(confirm).toHaveBeenLastCalledWith(event, { message });
      expect(send).toHaveBeenLastCalledWith(
        "session-a",
        { text, images: [], files: [] },
        { allowDestructive: true },
      );
    }
  });

  it("does not send a destructive command whose confirmation was refused", async () => {
    const { send, confirm } = setup("deny");
    await expect(
      handled.get(GJC_IPC.sendMessage)!({ sender: { id: 7 } }, "session-a", {
        text: "/session delete",
        images: [],
        files: [],
      }),
    ).rejects.toThrow("cancelled");
    expect(confirm).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not ask for ordinary prompts", async () => {
    const { send, confirm } = setup();
    await handled.get(GJC_IPC.sendMessage)!({ sender: { id: 7 } }, "session-a", {
      text: "/session info",
      images: [],
      files: [],
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "session-a",
      { text: "/session info", images: [], files: [] },
      { allowDestructive: false },
    );
  });
});

describe("attachment IPC validation", () => {
  it("rejects renderer-selected native paths", () => {
    expect(() =>
      messageInput({
        text: "read",
        images: [],
        files: [
          {
            id: "file-1",
            name: "note.txt",
            mimeType: "text/plain",
            size: 5,
            token: "a".repeat(43),
            path: "/tmp/note.txt",
          },
        ],
      }),
    ).toThrow("Invalid file attachment");
  });

  it("accepts safe Unicode attachment names", () => {
    expect(
      messageInput({
        text: "검토",
        images: [],
        files: [
          {
            id: "file-1",
            name: "스크린샷 메모.md",
            mimeType: "text/markdown",
            size: 5,
            token: "a".repeat(43),
          },
        ],
      }).files[0]?.name,
    ).toBe("스크린샷 메모.md");
  });

  it("resolves a same-sender capability and retains it for delivery retry", async () => {
    const { file, metadata } = await nativeFile();
    const store = new AttachmentStore();
    store.activateSender(7);
    const capability = await store.issue(7, "file", file, metadata);
    const operation = vi.fn().mockResolvedValue("sent");

    await expect(
      withResolvedMessageInput(
        store,
        7,
        {
          text: "read",
          images: [],
          files: [
            {
              id: "file-1",
              name: metadata.name,
              mimeType: metadata.mimeType,
              size: metadata.size,
              token: capability.token,
            },
          ],
        },
        operation,
      ),
    ).resolves.toBe("sent");
    expect(operation).toHaveBeenCalledWith({
      text: "read",
      images: [],
      files: [
        {
          id: "file-1",
          name: metadata.name,
          mimeType: metadata.mimeType,
          size: metadata.size,
          nativePath: await realpath(file),
        },
      ],
    });
    await expect(store.acquire(7, [capability.token])).resolves.toEqual([
      expect.objectContaining({ token: capability.token, nativePath: await realpath(file) }),
    ]);
  });

  it("releases a capability after a failed send and rejects another sender", async () => {
    const { file, metadata } = await nativeFile();
    const store = new AttachmentStore();
    store.activateSender(7);
    store.activateSender(8);
    const capability = await store.issue(7, "file", file, metadata);
    const input = {
      text: "read",
      images: [],
      files: [
        {
          id: "file-1",
          name: metadata.name,
          mimeType: metadata.mimeType,
          size: metadata.size,
          token: capability.token,
        },
      ],
    };

    await expect(
      withResolvedMessageInput(store, 8, input, vi.fn()),
    ).rejects.toThrow("Attachment is unavailable");
    await expect(
      withResolvedMessageInput(store, 7, input, async () => {
        throw new Error(`send failed for ${await realpath(file)}`);
      }),
    ).rejects.toThrow("send failed for note.txt");
    await expect(
      withResolvedMessageInput(store, 7, input, async () => {
        throw new Error(`send failed for ${await realpath(file)}`);
      }),
    ).rejects.not.toThrow(await realpath(file));
    await expect(
      withResolvedMessageInput(store, 7, input, async () => "retried"),
    ).resolves.toBe("retried");
  });

  it("rejects metadata swaps without consuming the capability", async () => {
    const { file, metadata } = await nativeFile();
    const store = new AttachmentStore();
    store.activateSender(7);
    const capability = await store.issue(7, "file", file, metadata);
    const forged = {
      text: "read",
      images: [],
      files: [
        {
          id: "file-1",
          name: "other.txt",
          mimeType: metadata.mimeType,
          size: metadata.size,
          token: capability.token,
        },
      ],
    };

    await expect(
      withResolvedMessageInput(store, 7, forged, vi.fn()),
    ).rejects.toThrow("Attachment metadata mismatch");
    expect(await store.acquire(7, [capability.token])).toHaveLength(1);
  });

  it("counts token-backed image bytes toward the message limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gajae-image-limit-"));
    roots.push(root);
    const file = path.join(root, "large.png");
    await writeFile(file, Buffer.alloc(9 * 1024 * 1024));
    const info = await stat(file);
    const metadata = {
      name: "large.png",
      mimeType: "image/png",
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
    const store = new AttachmentStore();
    store.activateSender(7);
    const capabilities = await Promise.all(
      Array.from({ length: 6 }, () => store.issue(7, "image", file, metadata)),
    );
    const operation = vi.fn();

    await expect(
      withResolvedMessageInput(
        store,
        7,
        {
          text: "inspect",
          files: [],
          images: capabilities.map((capability, index) => ({
            id: `image-${index}`,
            name: metadata.name,
            mimeType: metadata.mimeType,
            token: capability.token,
            data: "",
          })),
        },
        operation,
      ),
    ).rejects.toThrow("Attachment size limit exceeded");
    expect(operation).not.toHaveBeenCalled();
  });
});

describe("transcript page IPC", () => {
  const page: TranscriptPage = {
    items: [],
    hasMoreBefore: true,
    hasMoreAfter: false,
    firstId: "first",
    lastId: "last",
    requests: [],
  };

  function setup() {
    const getTranscriptPage = vi.fn().mockResolvedValue(page);
    const guarded = vi.fn(
      (handler: (...args: unknown[]) => unknown) =>
        async (...args: unknown[]) => handler(...args),
    );
    registerGjcIpcHandlers(
      { getTranscriptPage } as unknown as GjcSdkController,
      new AttachmentStore(),
      { guarded } as unknown as IpcSecurity,
    );
    return getTranscriptPage;
  }

  it("passes initial, before, and around requests through and returns the controller page", async () => {
    const getTranscriptPage = setup();
    const handler = handled.get(GJC_IPC.getTranscriptPage)!;

    await expect(handler({}, "session-a")).resolves.toBe(page);
    await expect(handler({}, "session-a", { beforeId: "message-before" })).resolves.toBe(page);
    await expect(handler({}, "session-a", { aroundId: "message-around" })).resolves.toBe(page);

    expect(getTranscriptPage.mock.calls).toEqual([
      ["session-a", undefined],
      ["session-a", { beforeId: "message-before" }],
      ["session-a", { aroundId: "message-around" }],
    ]);
  });

  it("rejects invalid request types, unknown fields, and conflicting cursors before the controller", async () => {
    const getTranscriptPage = setup();
    const handler = handled.get(GJC_IPC.getTranscriptPage)!;
    const invalidRequests: unknown[] = [
      null,
      [],
      "before",
      1,
      { beforeId: "" },
      { beforeId: "x".repeat(513) },
      { afterId: "message-after" },
      { beforeId: "message-before", aroundId: "message-around" },
    ];

    for (const request of invalidRequests)
      await expect(handler({}, "session-a", request)).rejects.toThrow();
    expect(getTranscriptPage).not.toHaveBeenCalled();
  });
});

describe("explicit compaction action", () => {
  function setup() {
    const compact = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn().mockResolvedValue(undefined);
    const guarded = vi.fn((handler: (...args: unknown[]) => unknown) => async (...args: unknown[]) => handler(...args));
    registerGjcIpcHandlers(
      { compactSession: compact, deleteSession: remove } as unknown as GjcSdkController,
      new AttachmentStore(),
      { guarded, authorizeDestructive: confirm } as unknown as IpcSecurity,
    );
    return { compact, remove, confirm, guarded };
  }

  it("compacts without opening a native confirmation dialog", async () => {
    const { compact, confirm } = setup();
    await handled.get(GJC_IPC.compactSession)!({}, "session-a");
    expect(compact).toHaveBeenCalledExactlyOnceWith("session-a");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rejects invalid targets before calling the controller", async () => {
    const { compact, confirm } = setup();
    await expect(handled.get(GJC_IPC.compactSession)!({}, "")).rejects.toThrow("Session ID");
    expect(compact).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps sender authorization on the compaction handler", async () => {
    const compact = vi.fn();
    const guarded = vi.fn(() => async () => { throw new Error("Untrusted sender"); });
    registerGjcIpcHandlers(
      { compactSession: compact } as unknown as GjcSdkController,
      new AttachmentStore(),
      { guarded } as unknown as IpcSecurity,
    );
    await expect(handled.get(GJC_IPC.compactSession)!({}, "session-a")).rejects.toThrow("Untrusted sender");
    expect(compact).not.toHaveBeenCalled();
  });

  it("propagates runtime errors without adding another confirmation", async () => {
    const { compact, confirm } = setup();
    compact.mockRejectedValueOnce(new Error("Runtime refused compaction"));
    await expect(handled.get(GJC_IPC.compactSession)!({}, "session-a")).rejects.toThrow("Runtime refused compaction");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("still confirms session deletion", async () => {
    const { remove, confirm } = setup();
    const event = {};
    await handled.get(GJC_IPC.deleteSession)!(event, "session-a");
    expect(confirm).toHaveBeenCalledExactlyOnceWith(event, { message: "세션을 삭제할까요?" });
    expect(remove).toHaveBeenCalledExactlyOnceWith("session-a");
  });
});
