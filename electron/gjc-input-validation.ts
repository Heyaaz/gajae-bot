import { statSync } from "node:fs";
import path from "node:path";
import type {
  CreateSessionInput,
  FileAttachment,
  ImageAttachment,
  MessageInput,
  QuestionSubmission,
  ToolDecision,
} from "../shared/agent-contract.js";
import { parseSessionWorkLink } from "../shared/agent-contract.js";

/**
 * Input validation shared by the Electron IPC surface and the remote access
 * server.
 *
 * Both entry points accept the same renderer-shaped payloads, and both must
 * reject the same things: unbounded strings, control characters, renderer-
 * supplied native paths, mismatched attachment metadata. Keeping one copy means
 * a fix to a validation rule cannot land on only one of the two doors.
 */

export function requiredString(value: unknown, label: string): string {
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

export function requiredId(value: unknown, label: string): string {
  const id = requiredString(value, label);
  if (id.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new Error(`${label} is invalid`);
  }
  return id;
}

export function attachmentName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    /[\\/\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new Error("Attachment name is invalid");
  return value;
}

export function createSessionInput(value: unknown): CreateSessionInput {
  if (!value || typeof value !== "object")
    throw new Error("Session input is required");
  const candidate = value as {
    title?: unknown;
    runtime?: unknown;
    workspace?: unknown;
    isolation?: unknown;
    worktreeBranch?: unknown;
    worktreeBranchExisting?: unknown;
    workLink?: unknown;
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
  if (
    candidate.worktreeBranchExisting !== undefined &&
    (candidate.worktreeBranchExisting !== true ||
      candidate.isolation !== "worktree" ||
      candidate.worktreeBranch === undefined)
  )
    throw new Error("Only a named worktree branch can be required to exist");
  const workLink =
    candidate.workLink === undefined
      ? undefined
      : parseSessionWorkLink(candidate.workLink);
  if (candidate.workLink !== undefined && !workLink)
    throw new Error("Session work link is invalid");
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
    ...(candidate.worktreeBranchExisting ? { worktreeBranchExisting: true } : {}),
    ...(workLink ? { workLink } : {}),
  };
}

export function imageAttachment(value: unknown): ImageAttachment {
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

const QUESTION_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;

function optionalQuestionText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 8_000)
    throw new Error(`${label} is invalid`);
  return value;
}

/** The answer a question card submits. Schema checks happen against the gate. */
export function questionSubmission(value: unknown): QuestionSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Question answer is required");
  const record = value as { selected?: unknown; custom?: unknown; clarify?: unknown };
  if (
    !Array.isArray(record.selected) ||
    record.selected.length > 32 ||
    record.selected.some((item) => typeof item !== "string" || item.length > 500)
  )
    throw new Error("Question selection is invalid");
  const custom = optionalQuestionText(record.custom, "Custom answer");
  const clarify = optionalQuestionText(record.clarify, "Clarification");
  return {
    selected: record.selected.map((item) => item.trim()).filter(Boolean),
    ...(custom !== undefined ? { custom } : {}),
    ...(clarify !== undefined ? { clarify } : {}),
  };
}

export function questionIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !QUESTION_IDEMPOTENCY_KEY.test(value))
    throw new Error("Question idempotency key is invalid");
  return value;
}

export function toolDecision(value: unknown): ToolDecision {
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

export function gitPaths(value: unknown): string[] {
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
