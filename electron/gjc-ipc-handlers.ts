import { ipcMain } from "electron";
import { statSync } from "node:fs";
import path from "node:path";
import type {
  CreateSessionInput,
  ImageAttachment,
  MessageDelivery,
  MessageInput,
  ToolDecision,
  FileAttachment,
} from "../shared/agent-contract.js";
import { GJC_IPC } from "../shared/gjc-ipc.js";
import type { GjcAcpController } from "./gjc-acp-controller.js";
import { AttachmentStore } from "./attachment-store.js";
import type { ResolvedMessageInput } from "./gjc-acp-controller.js";
import type { IpcSecurity } from "./ipc-security.js";

function requiredString(value: unknown, label: string): string {
  const hasControlCharacter =
    typeof value === "string" &&
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    hasControlCharacter
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value.trim();
}

function requiredId(value: unknown, label: string): string {
  const id = requiredString(value, label);
  if (id.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new Error(`${label} is invalid`);
  }
  return id;
}

function attachmentName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    /[\\/\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new Error("Attachment name is invalid");
  return value;
}

function createSessionInput(value: unknown): CreateSessionInput {
  if (!value || typeof value !== "object")
    throw new Error("Session input is required");
  const candidate = value as {
    title?: unknown;
    runtime?: unknown;
    workspace?: unknown;
    isolation?: unknown;
    worktreeBranch?: unknown;
  };
  if (candidate.runtime !== "gjc")
    throw new Error("Only the GJC runtime is available through this bridge");
  if (candidate.title !== undefined && typeof candidate.title !== "string") {
    throw new Error("Session title must be a string");
  }
  if (
    typeof candidate.workspace !== "string" ||
    !path.isAbsolute(candidate.workspace)
  ) {
    throw new Error("Session workspace must be an absolute directory");
  }
  if (
    candidate.isolation !== "workspace" &&
    candidate.isolation !== "worktree"
  ) {
    throw new Error("Session isolation must be workspace or worktree");
  }
  if (
    candidate.worktreeBranch !== undefined &&
    (typeof candidate.worktreeBranch !== "string" ||
      candidate.worktreeBranch.length === 0 ||
      candidate.worktreeBranch.length > 256 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/.test(
        candidate.worktreeBranch,
      ) ||
      candidate.worktreeBranch.includes("..") ||
      candidate.worktreeBranch.includes("//") ||
      candidate.worktreeBranch.includes("@{"))
  ) {
    throw new Error("Session worktree branch is invalid");
  }
  try {
    if (!statSync(candidate.workspace).isDirectory()) throw new Error();
  } catch {
    throw new Error("Session workspace must be an existing directory");
  }
  return {
    runtime: "gjc",
    workspace: path.resolve(candidate.workspace),
    isolation: candidate.isolation,
    ...(candidate.title ? { title: candidate.title } : {}),
    ...(candidate.worktreeBranch !== undefined
      ? { worktreeBranch: candidate.worktreeBranch }
      : {}),
  };
}

function imageAttachment(value: unknown): ImageAttachment {
  if (!value || typeof value !== "object")
    throw new Error("Image attachment must be an object");
  const candidate = value as Partial<ImageAttachment>;
  if (typeof candidate.id !== "string" || !candidate.id)
    throw new Error("Image ID is required");
  const name = attachmentName(candidate.name);
  if (candidate.token !== undefined && (typeof candidate.token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(candidate.token)))
    throw new Error("Invalid attachment token");
  if (
    typeof candidate.mimeType !== "string" ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      candidate.mimeType,
    )
  ) {
    throw new Error("Unsupported image type");
  }
  if (Object.prototype.hasOwnProperty.call(candidate, "path")) throw new Error("Attachment path is not allowed");
  if (
    candidate.data !== undefined && (typeof candidate.data !== "string" || candidate.data.length > 14_000_000)
  ) {
    throw new Error("Image data is missing or exceeds the 10 MB limit");
  }
  if (candidate.token === undefined && (!candidate.data || candidate.data.length === 0)) throw new Error("Image data is required");
  return {
    id: candidate.id,
    name,
    mimeType: candidate.mimeType,
    ...(candidate.token !== undefined ? { token: candidate.token } : {}),
    data: candidate.data ?? "",
  };
}

export function messageInput(value: unknown): MessageInput {
  if (!value || typeof value !== "object")
    throw new Error("Message input is required");
  const candidate = value as {
    text?: unknown;
    images?: unknown;
    files?: unknown;
  };
  if (typeof candidate.text !== "string")
    throw new Error("Message text must be a string");
  if (!Array.isArray(candidate.images) || candidate.images.length > 6)
    throw new Error("Attach at most 6 images per message");
  const images = candidate.images.map(imageAttachment);
  if (candidate.files !== undefined && !Array.isArray(candidate.files))
    throw new Error("Files must be an array");
  if (Array.isArray(candidate.files) && candidate.files.length > 5)
    throw new Error("Attach at most 5 files per message");
  const files = (candidate.files ?? []).map((value): FileAttachment => {
    if (!value || typeof value !== "object")
      throw new Error("File attachment must be an object");
    const file = value as Partial<FileAttachment>;
    if (
      typeof file.id !== "string" ||
      !file.id ||
      typeof file.mimeType !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}$/.test(
        file.mimeType,
      ) ||
      Object.prototype.hasOwnProperty.call(file, "path") ||
      typeof file.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(file.token) ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new Error("Invalid file attachment");
    return {
      id: file.id,
      name: attachmentName(file.name),
      mimeType: file.mimeType,
      size: file.size,
      token: file.token,
    };
  });
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0) + images.reduce((sum, image) => sum + Math.ceil(image.data.length * 3 / 4), 0);
  if (files.some((file) => file.size > 25 * 1024 * 1024) || totalBytes > 50 * 1024 * 1024)
    throw new Error("Attachment size limit exceeded");
  if (!candidate.text.trim() && images.length === 0 && files.length === 0)
    throw new Error("Message text or an attachment is required");
  return { text: candidate.text, images, files };
}

export async function withResolvedMessageInput<T>(
  attachments: AttachmentStore,
  senderId: number,
  raw: unknown,
  operation: (input: ResolvedMessageInput) => Promise<T>,
): Promise<T> {
  const input = messageInput(raw);
  const imageTokens = input.images.flatMap((image) =>
    image.token ? [image.token] : [],
  );
  const tokens = [...imageTokens, ...input.files.map((file) => file.token)];
  if (new Set(tokens).size !== tokens.length)
    throw new Error("Attachment tokens cannot repeat");
  const leases = tokens.length ? await attachments.acquire(senderId, tokens) : [];
  for (const image of input.images) {
    if (!image.token) continue;
    const lease = leases.find((value) => value.token === image.token);
    const decodedSize = image.data
      ? Buffer.from(image.data, "base64").byteLength
      : lease?.size;
    if (
      !lease ||
      lease.kind !== "image" ||
      lease.name !== image.name ||
      lease.mimeType !== image.mimeType ||
      decodedSize !== lease.size
    ) {
      attachments.release(senderId, tokens);
      throw new Error("Attachment metadata mismatch");
    }
  }
  for (const file of input.files) {
    const lease = leases.find((value) => value.token === file.token);
    if (
      !lease ||
      lease.kind !== "file" ||
      lease.name !== file.name ||
      lease.mimeType !== file.mimeType ||
      lease.size !== file.size
    ) {
      attachments.release(senderId, tokens);
      throw new Error("Attachment metadata mismatch");
    }
  }
  const authoritativeBytes =
    leases.reduce((sum, lease) => sum + lease.size, 0) +
    input.images
      .filter((image) => !image.token)
      .reduce(
        (sum, image) => sum + Buffer.from(image.data, "base64").byteLength,
        0,
      );
  if (authoritativeBytes > 50 * 1024 * 1024) {
    if (tokens.length) attachments.release(senderId, tokens);
    throw new Error("Attachment size limit exceeded");
  }
  const byToken = new Map(leases.map((lease) => [lease.token, lease]));
  const resolved: ResolvedMessageInput = {
    text: input.text,
    images: input.images.map((image) =>
      image.token
        ? {
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            data: image.data,
            nativePath: byToken.get(image.token)!.nativePath,
          }
        : {
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            data: image.data,
          },
    ),
    files: input.files.map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      nativePath: byToken.get(file.token)!.nativePath,
    })),
  };
  try {
    const result = await operation(resolved);
    if (tokens.length) attachments.commit(senderId, tokens);
    return result;
  } catch (error) {
    if (tokens.length) attachments.release(senderId, tokens);
    if (leases.length === 0) throw error;
    let message = error instanceof Error ? error.message : String(error);
    for (const lease of leases)
      message = message.replaceAll(lease.nativePath, lease.name);
    throw new Error(message || "Attachment delivery failed");
  }
}

function toolDecision(value: unknown): ToolDecision {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tool decision must be an object");
  const optionId = (value as { optionId?: unknown }).optionId;
  if (
    typeof optionId !== "string" ||
    !optionId.trim() ||
    optionId.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(optionId)
  ) {
    throw new Error("Tool decision optionId is invalid");
  }
  return { optionId: optionId.trim() };
}

function gitPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200)
    throw new Error("Git paths must be a non-empty bounded array");
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !entry ||
      entry.length > 1024 ||
      path.isAbsolute(entry) ||
      entry.includes("\0")
    ) {
      throw new Error("Git path must be a safe repository-relative path");
    }
    return entry;
  });
}

export function registerGjcIpcHandlers(
  controller: GjcAcpController,
  attachments: AttachmentStore,
  security: IpcSecurity,
): () => void {
  const handle = (channel: string, handler: (...args: any[]) => any): void => {
    ipcMain.handle(channel, security.guarded(async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
      return handler(event, ...args);
    }));
  };
  const deliver = async (event: Electron.IpcMainInvokeEvent, sessionId: unknown, raw: unknown, method: "sendMessage" | "steerSession" | "queueFollowUp") => {
    const id = requiredId(sessionId, "Session ID");
    return withResolvedMessageInput<MessageDelivery | void>(
      attachments,
      event.sender.id,
      raw,
      (input) => {
        security.owner(event);
        if (method === "sendMessage") return controller.sendMessage(id, input);
        if (method === "steerSession") return controller.steerSession(id, input);
        return controller.queueFollowUp(id, input);
      },
    );
  };
  handle(GJC_IPC.getConnection, () => controller.getConnection());
  handle(GJC_IPC.listSessions, () => controller.listSessions());
  handle(GJC_IPC.createSession, (_event, input: unknown) =>
    controller.createSession(createSessionInput(input)),
  );
  handle(GJC_IPC.forkSession, (_event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Fork input is required");
    const candidate = input as { sourceSessionId?: unknown; title?: unknown };
    if (
      candidate.title !== undefined &&
      (typeof candidate.title !== "string" || candidate.title.length > 256)
    )
      throw new Error("Fork title is invalid");
    return controller.forkSession({
      sourceSessionId: requiredId(
        candidate.sourceSessionId,
        "Source session ID",
      ),
      ...(typeof candidate.title === "string" && candidate.title.trim()
        ? { title: candidate.title.trim() }
        : {}),
    });
  });
  handle(
    GJC_IPC.renameSession,
    (_event, sessionId: unknown, title: unknown) =>
      controller.renameSession(
        requiredId(sessionId, "Session ID"),
        requiredString(title, "Session title"),
      ),
  );
  handle(GJC_IPC.resumeSession, (_event, sessionId: unknown) =>
    controller.resumeSession(requiredId(sessionId, "Session ID")),
  );
  handle(GJC_IPC.listHistorySessions, () =>
    controller.listHistorySessions(),
  );
  handle(GJC_IPC.openHistorySession, (_event, sessionId: unknown) =>
    controller.openHistorySession(requiredId(sessionId, "Session ID")),
  );
  handle(GJC_IPC.deleteSession, async (event, sessionId: unknown) => {
    const id = requiredId(sessionId, "Session ID");
    await security.authorizeDestructive(event, {
      message: "Delete this session?",
      detail: `Session ${id} and its retained artifacts will be removed.`,
    });
    return controller.deleteSession(id);
  });
  handle(GJC_IPC.getTranscript, (_event, sessionId: unknown) =>
    controller.getTranscript(requiredId(sessionId, "Session ID")),
  );
  handle(
    GJC_IPC.setSessionConfig,
    (_event, sessionId: unknown, configId: unknown, value: unknown) => {
      if (typeof value !== "string")
        throw new Error("Config value must be a string");
      return controller.setSessionConfig(
        requiredId(sessionId, "Session ID"),
        requiredId(configId, "Config ID"),
        value,
      );
    },
  );
  handle(GJC_IPC.cycleThinking, (_event, sessionId: unknown) =>
    controller.cycleThinking(requiredId(sessionId, "Session ID")),
  );
  handle(GJC_IPC.compactSession, async (event, sessionId: unknown) => {
    const id = requiredId(sessionId, "Session ID");
    await security.authorizeDestructive(event, {
      message: "Compact this session?",
      detail: `Session ${id} history will be rewritten.`,
    });
    return controller.compactSession(id);
  });
  handle(
    GJC_IPC.queueFollowUp,
    (event, sessionId: unknown, input: unknown) => deliver(event, sessionId, input, "queueFollowUp"),
  );
  handle(GJC_IPC.listQueuedMessages, (_event, sessionId: unknown) =>
    controller.listQueuedMessages(requiredId(sessionId, "Session ID")),
  );
  handle(GJC_IPC.flushQueuedNow, (_event, sessionId: unknown) =>
    controller.flushQueuedNow(requiredId(sessionId, "Session ID")),
  );
  handle(
    GJC_IPC.steerSession,
    (event, sessionId: unknown, input: unknown) => deliver(event, sessionId, input, "steerSession"),
  );
  handle(
    GJC_IPC.sendMessage,
    (event, sessionId: unknown, input: unknown) => deliver(event, sessionId, input, "sendMessage"),
  );
  handle(GJC_IPC.cancelRun, (_event, sessionId: unknown) =>
    controller.cancelRun(requiredId(sessionId, "Session ID")),
  );
  handle(GJC_IPC.resolveToolCall, async (event, toolId: unknown, decision: unknown) => {
    const id = requiredId(toolId, "Tool call ID");
    const selected = toolDecision(decision);
    const info = controller.toolDecisionInfo(id, selected);
    if (info.requiresConfirmation)
      await security.authorizeDestructive(event, {
        message: "Allow this tool action?",
        detail: info.name,
      });
    return controller.resolveToolCall(id, selected);
  });
  handle(GJC_IPC.markSessionRead, (_event, sessionId: unknown) =>
    controller.markSessionRead(requiredId(sessionId, "Session ID")),
  );
  handle(GJC_IPC.getDiff, (_event, sessionId: unknown) =>
    controller.getDiff(requiredId(sessionId, "Session ID")),
  );
  handle(
    GJC_IPC.readArtifact,
    (_event, sessionId: unknown, artifactId: unknown) =>
      controller.readArtifact(
        requiredId(sessionId, "Session ID"),
        requiredId(artifactId, "Artifact ID"),
      ),
  );
  handle(
    GJC_IPC.previewFile,
    (_event, sessionId: unknown, filePath: unknown) =>
      controller.previewFile(
        requiredId(sessionId, "Session ID"),
        requiredString(filePath, "File path"),
      ),
  );
  handle(GJC_IPC.getGoal, (_event, sessionId: unknown) =>
    controller.getGoal(requiredId(sessionId, "Session ID")),
  );
  handle(
    GJC_IPC.operateGoal,
    async (event, sessionId: unknown, operation: unknown) => {
      if (
        operation !== "pause" &&
        operation !== "resume" &&
        operation !== "complete" &&
        operation !== "drop"
      )
        throw new Error("Goal operation is invalid");
      const id = requiredId(sessionId, "Session ID");
      if (operation === "complete" || operation === "drop")
        await security.authorizeDestructive(event, {
          message: operation === "drop" ? "Drop this goal?" : "Mark this goal complete?",
          detail: `Session ${id}`,
        });
      return controller.operateGoal(
        id,
        operation,
      );
    },
  );
  handle(GJC_IPC.listSubagents, (_event, sessionId: unknown) =>
    controller.listSubagents(requiredId(sessionId, "Session ID")),
  );
  handle(GJC_IPC.refreshRuntimeState, (_event, sessionId: unknown) =>
    controller.refreshRuntimeState(requiredId(sessionId, "Session ID")),
  );
  handle(GJC_IPC.reconnect, () => controller.reconnect());
  handle(GJC_IPC.getGitStatus, (_event, sessionId: unknown) =>
    controller.getGitStatus(requiredId(sessionId, "Session ID")),
  );
  handle(
    GJC_IPC.stageFiles,
    (_event, sessionId: unknown, paths: unknown) =>
      controller.stageFiles(
        requiredId(sessionId, "Session ID"),
        gitPaths(paths),
      ),
  );
  handle(
    GJC_IPC.unstageFiles,
    (_event, sessionId: unknown, paths: unknown) =>
      controller.unstageFiles(
        requiredId(sessionId, "Session ID"),
        gitPaths(paths),
      ),
  );
  handle(
    GJC_IPC.commitChanges,
    async (event, sessionId: unknown, message: unknown) => {
      const id = requiredId(sessionId, "Session ID");
      const commitMessage = requiredString(message, "Commit message");
      await security.authorizeDestructive(event, {
        message: "Commit staged changes?",
        detail: commitMessage,
      });
      return controller.commitChanges(id, commitMessage);
    },
  );
  handle(GJC_IPC.pushChanges, async (event, sessionId: unknown) => {
    const id = requiredId(sessionId, "Session ID");
    await security.authorizeDestructive(event, {
      message: "Push committed changes?",
      detail: `Session ${id}`,
    });
    return controller.pushChanges(id);
  });

  return () => {
    for (const channel of Object.values(GJC_IPC)) {
      if (channel !== GJC_IPC.event) ipcMain.removeHandler(channel);
    }
  };
}
