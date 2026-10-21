import { createHash } from "node:crypto";
import {
  TRANSCRIPT_BODY_ARTIFACT_PREFIX,
  type ArtifactContent,
  type ToolActivity,
  type TranscriptItem,
} from "../shared/agent-contract.js";

const COMMAND_PREVIEW_BYTES = 256;
const OUTPUT_PREVIEW_BYTES = 512;
const COMMAND_ARTIFACT_BYTES = 1024;
const OUTPUT_ARTIFACT_BYTES = 2048;
const PREVIEW_MARKER = "\n\n[Preview truncated; full content available as artifact]";
const SYNTHETIC_ARTIFACT_PATTERN = new RegExp(
  `^${TRANSCRIPT_BODY_ARTIFACT_PREFIX}(input|output)-([0-9a-f]{64})-([0-9a-f]{64})$`,
  "u",
);

type BodyField = "input" | "output";

function fieldProperty(field: BodyField): "command" | "output" {
  return field === "input" ? "command" : "output";
}

function artifactProperty(
  field: BodyField,
): "inputArtifactId" | "outputArtifactId" {
  return field === "input" ? "inputArtifactId" : "outputArtifactId";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function rowDigest(sessionId: string, rowId: string): string {
  return createHash("sha256")
    .update(`${Buffer.byteLength(sessionId, "utf8")}:`, "utf8")
    .update(sessionId, "utf8")
    .update(`${Buffer.byteLength(rowId, "utf8")}:`, "utf8")
    .update(rowId, "utf8")
    .digest("hex");
}

function syntheticArtifactId(
  field: BodyField,
  sessionId: string,
  rowId: string,
  content: string,
): string {
  return `${TRANSCRIPT_BODY_ARTIFACT_PREFIX}${field}-${rowDigest(sessionId, rowId)}-${sha256(content)}`;
}

function isAlreadyProjected(
  field: BodyField,
  artifactId: string | undefined,
  content: string,
): boolean {
  if (!artifactId || !content.endsWith(PREVIEW_MARKER)) return false;
  const match = SYNTHETIC_ARTIFACT_PATTERN.exec(artifactId);
  return match?.[1] === field;
}

function firstUtf8Bytes(text: string, maxBytes: number): string {
  let byteLength = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > maxBytes) break;
    byteLength += characterBytes;
    end += character.length;
  }
  return text.slice(0, end);
}

function preview(text: string, maxBytes: number): string {
  return `${firstUtf8Bytes(text, maxBytes)}${PREVIEW_MARKER}`;
}

function projectField(
  row: ToolActivity,
  field: BodyField,
): ToolActivity | undefined {
  const property = fieldProperty(field);
  const artifactKey = artifactProperty(field);
  const content = row[property];
  if (content === undefined) return undefined;

  const previewBytes =
    field === "input" ? COMMAND_PREVIEW_BYTES : OUTPUT_PREVIEW_BYTES;
  const artifactBytes =
    field === "input" ? COMMAND_ARTIFACT_BYTES : OUTPUT_ARTIFACT_BYTES;
  if (Buffer.byteLength(content, "utf8") <= artifactBytes) return undefined;
  if (isAlreadyProjected(field, row[artifactKey], content)) return undefined;

  return {
    ...row,
    [property]: preview(content, previewBytes),
    ...(row[artifactKey] === undefined
      ? {
          [artifactKey]: syntheticArtifactId(
            field,
            row.sessionId,
            row.id,
            content,
          ),
        }
      : {}),
  };
}

/**
 * Creates a bounded outbound view of settled tool bodies without changing the
 * authoritative transcript row used to resolve full content later.
 */
export function projectTranscriptItemForDelivery(
  item: TranscriptItem,
): TranscriptItem {
  if (
    item.kind !== "tool" ||
    (item.status !== "completed" &&
      item.status !== "failed" &&
      item.status !== "cancelled" &&
      item.status !== "denied")
  ) {
    return item;
  }

  const withCommand = projectField(item, "input");
  const projected = projectField(withCommand ?? item, "output");
  return projected ?? withCommand ?? item;
}

function staleArtifactError(artifactId: string): Error {
  return new Error(`Stale transcript body artifact reference: ${artifactId}`);
}

/**
 * Resolves only synthetic transcript-body references from the current full
 * transcript rows. Other artifact namespaces remain the caller's responsibility.
 */
export function resolveTranscriptBodyArtifact(
  sessionId: string,
  artifactId: string,
  items: readonly TranscriptItem[],
): ArtifactContent | undefined {
  if (!artifactId.startsWith(TRANSCRIPT_BODY_ARTIFACT_PREFIX)) return undefined;

  const match = SYNTHETIC_ARTIFACT_PATTERN.exec(artifactId);
  if (!match) {
    throw new Error(`Malformed transcript body artifact reference: ${artifactId}`);
  }
  const field = match[1] as BodyField;
  const expectedRowDigest = match[2];
  const expectedContentDigest = match[3];
  let matchingRowFound = false;

  for (const item of items) {
    if (
      item.kind !== "tool" ||
      item.sessionId !== sessionId ||
      rowDigest(sessionId, item.id) !== expectedRowDigest
    ) {
      continue;
    }
    matchingRowFound = true;

    const content = item[fieldProperty(field)];
    if (
      content === undefined ||
      sha256(content) !== expectedContentDigest
    ) {
      continue;
    }

    return {
      artifactId,
      text: content,
      complete: true,
      totalBytes: Buffer.byteLength(content, "utf8"),
    };
  }

  throw staleArtifactError(
    matchingRowFound ? artifactId : `${artifactId} (row missing or session mismatch)`,
  );
}
