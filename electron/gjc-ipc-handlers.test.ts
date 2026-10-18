import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GjcSdkController } from "./gjc-sdk-controller.js";
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

  it("resolves a same-sender capability and consumes it after success", async () => {
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
    await expect(store.acquire(7, [capability.token])).rejects.toThrow(
      "Attachment is unavailable",
    );
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
