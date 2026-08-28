import { ipcMain } from "electron";
import { statSync } from "node:fs";
import path from "node:path";
import type {
  CreateSessionInput,
  ImageAttachment,
  MessageInput,
  ToolDecision,
  FileAttachment,
} from "../shared/agent-contract.js";
import { GJC_IPC } from "../shared/gjc-ipc.js";
import type { GjcAcpController } from "./gjc-acp-controller.js";

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
  if (typeof candidate.name !== "string" || !candidate.name)
    throw new Error("Image name is required");
  if (
    typeof candidate.mimeType !== "string" ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      candidate.mimeType,
    )
  ) {
    throw new Error("Unsupported image type");
  }
  if (
    typeof candidate.path !== "string" ||
    !path.isAbsolute(candidate.path) ||
    /[\0\r\n]/u.test(candidate.path)
  ) {
    throw new Error("Image path is invalid");
  }
  if (
    typeof candidate.data !== "string" ||
    candidate.data.length === 0 ||
    candidate.data.length > 14_000_000
  ) {
    throw new Error("Image data is missing or exceeds the 10 MB limit");
  }
  return {
    id: candidate.id,
    name: candidate.name,
    mimeType: candidate.mimeType,
    path: candidate.path,
    data: candidate.data,
  };
}

function messageInput(value: unknown): MessageInput {
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
      typeof file.name !== "string" ||
      !/^[A-Za-z0-9._ -]{1,128}$/.test(file.name) ||
      typeof file.mimeType !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}$/.test(
        file.mimeType,
      ) ||
      typeof file.path !== "string" ||
      !path.isAbsolute(file.path) ||
      /[\0\r\n]/u.test(file.path) ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new Error("Invalid file attachment");
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      path: file.path,
    };
  });
  if (!candidate.text.trim() && images.length === 0 && files.length === 0)
    throw new Error("Message text or an attachment is required");
  return { text: candidate.text, images, files };
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
): () => void {
  ipcMain.handle(GJC_IPC.getConnection, () => controller.getConnection());
  ipcMain.handle(GJC_IPC.listSessions, () => controller.listSessions());
  ipcMain.handle(GJC_IPC.createSession, (_event, input: unknown) =>
    controller.createSession(createSessionInput(input)),
  );
  ipcMain.handle(GJC_IPC.forkSession, (_event, input: unknown) => {
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
  ipcMain.handle(
    GJC_IPC.renameSession,
    (_event, sessionId: unknown, title: unknown) =>
      controller.renameSession(
        requiredId(sessionId, "Session ID"),
        requiredString(title, "Session title"),
      ),
  );
  ipcMain.handle(GJC_IPC.resumeSession, (_event, sessionId: unknown) =>
    controller.resumeSession(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(GJC_IPC.listHistorySessions, () =>
    controller.listHistorySessions(),
  );
  ipcMain.handle(GJC_IPC.openHistorySession, (_event, sessionId: unknown) =>
    controller.openHistorySession(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(GJC_IPC.deleteSession, (_event, sessionId: unknown) =>
    controller.deleteSession(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(GJC_IPC.getTranscript, (_event, sessionId: unknown) =>
    controller.getTranscript(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(
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
  ipcMain.handle(GJC_IPC.cycleThinking, (_event, sessionId: unknown) =>
    controller.cycleThinking(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(GJC_IPC.compactSession, (_event, sessionId: unknown) =>
    controller.compactSession(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(
    GJC_IPC.queueFollowUp,
    (_event, sessionId: unknown, input: unknown) =>
      controller.queueFollowUp(
        requiredId(sessionId, "Session ID"),
        messageInput(input),
      ),
  );
  ipcMain.handle(GJC_IPC.listQueuedMessages, (_event, sessionId: unknown) =>
    controller.listQueuedMessages(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(GJC_IPC.flushQueuedNow, (_event, sessionId: unknown) =>
    controller.flushQueuedNow(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(
    GJC_IPC.steerSession,
    (_event, sessionId: unknown, input: unknown) =>
      controller.steerSession(
        requiredId(sessionId, "Session ID"),
        messageInput(input),
      ),
  );
  ipcMain.handle(
    GJC_IPC.sendMessage,
    (_event, sessionId: unknown, input: unknown) =>
      controller.sendMessage(
        requiredId(sessionId, "Session ID"),
        messageInput(input),
      ),
  );
  ipcMain.handle(GJC_IPC.cancelRun, (_event, sessionId: unknown) =>
    controller.cancelRun(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(
    GJC_IPC.resolveToolCall,
    (_event, toolId: unknown, decision: unknown) =>
      controller.resolveToolCall(
        requiredId(toolId, "Tool call ID"),
        toolDecision(decision),
      ),
  );
  ipcMain.handle(GJC_IPC.markSessionRead, (_event, sessionId: unknown) =>
    controller.markSessionRead(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(GJC_IPC.getDiff, (_event, sessionId: unknown) =>
    controller.getDiff(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(
    GJC_IPC.readArtifact,
    (_event, sessionId: unknown, artifactId: unknown) =>
      controller.readArtifact(
        requiredId(sessionId, "Session ID"),
        requiredId(artifactId, "Artifact ID"),
      ),
  );
  ipcMain.handle(
    GJC_IPC.previewFile,
    (_event, sessionId: unknown, filePath: unknown) =>
      controller.previewFile(
        requiredId(sessionId, "Session ID"),
        requiredString(filePath, "File path"),
      ),
  );
  ipcMain.handle(GJC_IPC.getGoal, (_event, sessionId: unknown) =>
    controller.getGoal(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(
    GJC_IPC.operateGoal,
    (_event, sessionId: unknown, operation: unknown) => {
      if (
        operation !== "pause" &&
        operation !== "resume" &&
        operation !== "complete" &&
        operation !== "drop"
      )
        throw new Error("Goal operation is invalid");
      return controller.operateGoal(
        requiredId(sessionId, "Session ID"),
        operation,
      );
    },
  );
  ipcMain.handle(GJC_IPC.listSubagents, (_event, sessionId: unknown) =>
    controller.listSubagents(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(GJC_IPC.refreshRuntimeState, (_event, sessionId: unknown) =>
    controller.refreshRuntimeState(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(GJC_IPC.reconnect, () => controller.reconnect());
  ipcMain.handle(GJC_IPC.getGitStatus, (_event, sessionId: unknown) =>
    controller.getGitStatus(requiredId(sessionId, "Session ID")),
  );
  ipcMain.handle(
    GJC_IPC.stageFiles,
    (_event, sessionId: unknown, paths: unknown) =>
      controller.stageFiles(
        requiredId(sessionId, "Session ID"),
        gitPaths(paths),
      ),
  );
  ipcMain.handle(
    GJC_IPC.unstageFiles,
    (_event, sessionId: unknown, paths: unknown) =>
      controller.unstageFiles(
        requiredId(sessionId, "Session ID"),
        gitPaths(paths),
      ),
  );
  ipcMain.handle(
    GJC_IPC.commitChanges,
    (_event, sessionId: unknown, message: unknown) =>
      controller.commitChanges(
        requiredId(sessionId, "Session ID"),
        requiredString(message, "Commit message"),
      ),
  );
  ipcMain.handle(GJC_IPC.pushChanges, (_event, sessionId: unknown) =>
    controller.pushChanges(requiredId(sessionId, "Session ID")),
  );

  return () => {
    for (const channel of Object.values(GJC_IPC)) {
      if (channel !== GJC_IPC.event) ipcMain.removeHandler(channel);
    }
  };
}
