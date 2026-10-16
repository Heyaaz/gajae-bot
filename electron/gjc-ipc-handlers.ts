import { ipcMain } from "electron";
import type { MessageDelivery } from "../shared/agent-contract.js";
import { GJC_IPC } from "../shared/gjc-ipc.js";
import {
  createSessionInput,
  gitPaths,
  messageInput,
  requiredId,
  requiredString,
  toolDecision,
} from "./gjc-input-validation.js";
// The attachment validation moved behind a shared module so the remote access
// server applies the same rules, but this stays the name the IPC tests use.
export { messageInput } from "./gjc-input-validation.js";
import type { GjcSdkController } from "./gjc-sdk-controller.js";
import { AttachmentStore } from "./attachment-store.js";
import type { ResolvedMessageInput } from "./gjc-sdk-controller.js";
import type { IpcSecurity } from "./ipc-security.js";

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

export function registerGjcIpcHandlers(
  controller: GjcSdkController,
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
      message: "세션을 삭제할까요?",
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
