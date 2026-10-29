import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import type { Stats } from "node:fs";
import {
  type ArtifactContent,
  type GeneratedFilePreview,
  TRANSCRIPT_BODY_ARTIFACT_PREFIX,
  type TranscriptItem,
} from "../shared/agent-contract.js";
import { GjcSdkCli } from "./gjc-sdk-cli.js";
import { redactSensitiveText } from "./gjc-sdk-foundation.js";
import { resolveTranscriptBodyArtifact } from "./transcript-body-preview.js";
import path from "node:path";

/**
 * Identity a cache can trust across an in-place rewrite.
 *
 * Size and mtime are not enough: a writer that restores the modification time
 * after replacing a file's contents leaves both unchanged. ctime moves on every
 * write and cannot be set back through the ordinary file APIs, so including it
 * keeps a same-size overwrite from looking like the previous parse.
 */
export function statsRevision(info: Stats): string {
  // The type bundled with this repo still names only the millisecond fields.
  const precise = info as Stats & { mtimeNs?: bigint; ctimeNs?: bigint };
  const mtime =
    precise.mtimeNs === undefined
      ? String(info.mtimeMs)
      : precise.mtimeNs.toString();
  const ctime =
    precise.ctimeNs === undefined
      ? String(info.ctimeMs)
      : precise.ctimeNs.toString();
  return `${info.dev}:${info.ino}:${info.size}:${mtime}:${ctime}`;
}

const SHARED_TRANSCRIPT_CACHE_LIMIT = 8;

/** The controller members artifact storage, file preview and transcript file reads touch. */
export interface FilesHost {
  readonly transcripts: Map<string, TranscriptItem[]>;
  getTranscript(sessionId: string): Promise<TranscriptItem[]>;
  readonly artifactDirectory: string;
  requireCli(): Promise<GjcSdkCli>;
  ensureAttached(
    sessionId: string,
    replay: boolean,
  ): Promise<void>;
  repoFor(sessionId: string): string;
  readonly deletingSessions: Set<string>;
  readonly artifactSessionIds: Map<string, Set<string>>;
  readonly artifactWrites: Map<string, Promise<void>>;
  nextLocalId: number;
  readonly sessionCwds: Map<string, string>;
  readonly workspace: string;
  readonly sharedSessionFiles: Map<string, string>;
  readonly sharedTranscriptReads: Map<
    string,
    {
      device: number;
      inode: number;
      size: number;
      revision: string;
      envelopes: Record<string, unknown>[];
      partial: string;
      bytesRead: number;
    }
  >;
}

export async function readArtifact(
  host: FilesHost,
  sessionId: string,
  artifactId: string,
): Promise<ArtifactContent> {
  if (!/^[A-Za-z0-9._-]+$/.test(artifactId))
    throw new Error("Invalid artifact id");
  if (artifactId.startsWith(TRANSCRIPT_BODY_ARTIFACT_PREFIX)) {
    // The installed array is authoritative. Only load it when this window has
    // not read the session yet; `getTranscript` clones every row, and opening a
    // large tool body should not copy the whole history each time.
    if (!host.transcripts.has(sessionId))
      await host.getTranscript(sessionId);
    const content = resolveTranscriptBodyArtifact(
      sessionId,
      artifactId,
      host.transcripts.get(sessionId) ?? [],
    );
    if (!content)
      throw new Error(`Invalid transcript body artifact reference: ${artifactId}`);
    return content;
  }
  const file = path.join(
    host.artifactDirectory,
    artifactNamespace(sessionId),
    `${artifactId}.json`,
  );
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as { text?: string };
    const text = raw.text ?? "";
    return {
      artifactId,
      text,
      complete: true,
      totalBytes: Buffer.byteLength(text),
    };
  } catch {
    const cli = await host.requireCli();
    await host.ensureAttached(sessionId, false);
    const chunks: Buffer[] = [];
    let offset = 0;
    let complete = false;
    while (!complete) {
      const envelope = await cli.rawQuery(
        sessionId,
        "artifact.read",
        { artifactId, offset, length: 256 * 1024 },
        { repo: host.repoFor(sessionId) },
      );
      const result =
        envelope.result &&
        typeof envelope.result === "object" &&
        !Array.isArray(envelope.result)
          ? (envelope.result as Record<string, unknown>)
          : envelope;
      if (typeof result.bytes !== "string")
        throw new Error(`Artifact ${artifactId} returned invalid data`);
      const chunk = Buffer.from(result.bytes, "base64");
      if (chunk.length === 0 && result.complete !== true)
        throw new Error(`Artifact ${artifactId} made no read progress`);
      chunks.push(chunk);
      offset += chunk.length;
      if (offset > 64 * 1024 * 1024)
        throw new Error(
          `Artifact ${artifactId} exceeds the 64 MB desktop read limit`,
        );
      complete = result.complete === true;
    }
    return {
      artifactId,
      text: Buffer.concat(chunks).toString("utf8"),
      complete,
      totalBytes: offset,
    };
  }
}

export async function persistArtifact(
  host: FilesHost,
  sessionId: string,
  artifactId: string,
  value: unknown,
): Promise<void> {
  if (host.deletingSessions.has(sessionId)) return;
  let sessionArtifacts = host.artifactSessionIds.get(sessionId);
  if (!sessionArtifacts) {
    sessionArtifacts = new Set<string>();
    host.artifactSessionIds.set(sessionId, sessionArtifacts);
  }
  sessionArtifacts.add(artifactId);
  const text = redactSensitiveText(
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
  const namespace = artifactNamespace(sessionId);
  const file = path.join(
    host.artifactDirectory,
    namespace,
    `${artifactId}.json`,
  );
  const writeKey = artifactWriteKey(sessionId, artifactId);
  const previous = host.artifactWrites.get(writeKey) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      if (host.deletingSessions.has(sessionId)) return;
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${host.nextLocalId++}.tmp`;
      await writeFile(temporary, JSON.stringify({ text }), { mode: 0o600 });
      await rename(temporary, file);
    });
  host.artifactWrites.set(writeKey, operation);
  try {
    await operation;
  } finally {
    if (host.artifactWrites.get(writeKey) === operation)
      host.artifactWrites.delete(writeKey);
  }
}

export async function removeSessionArtifacts(host: FilesHost, sessionId: string): Promise<void> {
  const ids = host.artifactSessionIds.get(sessionId) ?? new Set<string>();
  const writes = [...ids]
    .map((id) => host.artifactWrites.get(artifactWriteKey(sessionId, id)))
    .filter((write): write is Promise<void> => Boolean(write));
  if (writes.length > 0) await Promise.all(writes);
  await rm(
    path.join(host.artifactDirectory, artifactNamespace(sessionId)),
    { recursive: true, force: true },
  );
  host.artifactSessionIds.delete(sessionId);
}

function artifactNamespace(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function artifactWriteKey(sessionId: string, artifactId: string): string {
  return `${artifactNamespace(sessionId)}\0${artifactId}`;
}

export async function previewFile(
  host: FilesHost,
  sessionId: string,
  requestedPath: string,
): Promise<GeneratedFilePreview> {
  const workspace = await realpath(
    host.sessionCwds.get(sessionId) ?? host.workspace,
  );
  const resolved = await realpath(
    path.isAbsolute(requestedPath)
      ? requestedPath
      : path.join(workspace, requestedPath),
  );
  if (
    resolved !== workspace &&
    !resolved.startsWith(`${workspace}${path.sep}`)
  )
    throw new Error("Preview file must be inside the session workspace");
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("Preview target is not a file");
  const extension = path.extname(resolved).toLowerCase();
  const imageTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
  };
  const textTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".toml": "application/toml",
    ".csv": "text/csv",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".js": "text/javascript",
    ".jsx": "text/javascript",
    ".css": "text/css",
    ".py": "text/x-python",
    ".rs": "text/x-rust",
    ".go": "text/x-go",
  };
  const base = {
    path: resolved,
    name: path.basename(resolved),
    size: info.size,
  };
  if (imageTypes[extension]) {
    if (info.size > 20 * 1024 * 1024)
      throw new Error("Image preview exceeds 20 MiB");
    const bytes = await readFile(resolved);
    return {
      ...base,
      kind: "image",
      mimeType: imageTypes[extension]!,
      dataUrl: `data:${imageTypes[extension]};base64,${bytes.toString("base64")}`,
    };
  }
  if (extension === ".pdf") {
    if (info.size > 30 * 1024 * 1024)
      throw new Error("PDF preview exceeds 30 MiB");
    const bytes = await readFile(resolved);
    return {
      ...base,
      kind: "pdf",
      mimeType: "application/pdf",
      dataUrl: `data:application/pdf;base64,${bytes.toString("base64")}`,
    };
  }
  if (
    extension === ".md" ||
    extension === ".markdown" ||
    extension === ".html" ||
    extension === ".htm" ||
    textTypes[extension]
  ) {
    if (info.size > 2 * 1024 * 1024)
      throw new Error("Text preview exceeds 2 MiB");
    const content = await readFile(resolved, "utf8");
    const kind =
      extension === ".md" || extension === ".markdown"
        ? "markdown"
        : extension === ".html" || extension === ".htm"
          ? "html"
          : "text";
    return {
      ...base,
      kind,
      mimeType:
        kind === "html"
          ? "text/html"
          : kind === "markdown"
            ? "text/markdown"
            : textTypes[extension]!,
      content,
    };
  }
  return {
    ...base,
    kind: "unsupported",
    mimeType: "application/octet-stream",
  };
}

export async function locateSharedTranscriptFile(
  host: FilesHost,
  sessionId: string,
): Promise<string | undefined> {
  let filePath = host.sharedSessionFiles.get(sessionId);
  if (filePath) {
    try {
      await access(filePath);
      return filePath;
    } catch {
      host.sharedSessionFiles.delete(sessionId);
    }
  }
  const configuredAgentDirectory = path.resolve(
    process.env.GJC_CODING_AGENT_DIR ?? path.join(homedir(), ".gjc/agent"),
  );
  // GJC canonicalizes the workspace and the transcript path before matching a
  // resume target. `/tmp` and `/private/tmp` name one directory but compare as
  // two, so an agent directory reached through a symlinked temp root produced
  // `lifecycle_input_refused` for a transcript that was right there.
  const agentDirectory = await realpath(configuredAgentDirectory).catch(
    () => configuredAgentDirectory,
  );
  const sessionsDirectory = path.join(agentDirectory, "sessions");
  const suffix = `_${sessionId}.jsonl`;
  try {
    for (const bucket of await readdir(sessionsDirectory, {
      withFileTypes: true,
    })) {
      if (!bucket.isDirectory()) continue;
      const directory = path.join(sessionsDirectory, bucket.name);
      const candidates = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
        .map((entry) => path.join(directory, entry.name));
      if (candidates.length === 0) continue;
      // A re-host writes a new timestamped session file and leaves the older ones
      // in place, so the current generation is the newest match rather than
      // whichever the directory listing happens to return first. Handing GJC a
      // stale file made `session.delete` refuse with an unknown outcome.
      const stamped = await Promise.all(
        candidates.map(async (candidate) => ({
          candidate,
          mtimeMs: (await stat(candidate)).mtimeMs,
        })),
      );
      stamped.sort((left, right) => right.mtimeMs - left.mtimeMs);
      const candidate = stamped[0].candidate;
      filePath = await realpath(candidate).catch(() => candidate);
      host.sharedSessionFiles.set(sessionId, filePath);
      return filePath;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Parsed envelopes for an append-only transcript, reusing the previous parse
 * and reading only the appended tail. Re-parsing the whole file on every write
 * cost ~24ms per sync on a 14MB transcript, which several subagents writing at
 * once turned into visible lag.
 */
export async function readTranscriptEnvelopes(
  host: FilesHost,
  filePath: string,
  info: Stats,
): Promise<Record<string, unknown>[]> {
  const parseInto = (
    target: Record<string, unknown>[],
    chunk: string,
    carry: string,
  ): string => {
    const text = carry + chunk;
    const lines = text.split("\n");
    // A write can land mid-line, so the trailing fragment is held back until
    // the newline that completes it arrives.
    const tail = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        target.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // A torn or malformed line is skipped, matching the full-file parse.
      }
    }
    return tail;
  };

  const device = Number(info.dev);
  const inode = Number(info.ino);
  const revision = statsRevision(info);
  const previous = host.sharedTranscriptReads.get(filePath);
  const sameFile =
    previous !== undefined &&
    previous.device === device &&
    previous.inode === inode;

  if (sameFile && previous.revision === revision) {
    // An unchanged file is still a read, and the eviction order is what decides
    // which transcript survives. Returning early without touching it made the
    // most frequently polled session look like the stalest one.
    previous.bytesRead = 0;
    rememberTranscriptRead(host, filePath, previous);
    return previous.envelopes.slice();
  }

  // Only growth is safe to append to. A rewrite that happens to keep the same
  // size has to go through the full parse; the revision above tells them apart.
  if (sameFile && info.size > previous.size) {
    const handle = await open(filePath, "r");
    try {
      const length = info.size - previous.size;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, previous.size);
      const envelopes = previous.envelopes.slice();
      const partial = parseInto(
        envelopes,
        buffer.toString("utf8"),
        previous.partial,
      );
      rememberTranscriptRead(host, filePath, {
        device,
        inode,
        size: info.size,
        revision,
        envelopes,
        partial,
        bytesRead: length,
      });
      return envelopes.slice();
    } finally {
      await handle.close();
    }
  }

  const envelopes: Record<string, unknown>[] = [];
  const partial = parseInto(envelopes, await readFile(filePath, "utf8"), "");
  rememberTranscriptRead(host, filePath, {
    device,
    inode,
    size: info.size,
    revision,
    envelopes,
    partial,
    bytesRead: info.size,
  });
  return envelopes.slice();
}

/** Caches a parsed transcript, evicting the least recently read one past the limit. */
function rememberTranscriptRead(
  host: FilesHost,
  filePath: string,
  entry: {
    device: number;
    inode: number;
    size: number;
    revision: string;
    envelopes: Record<string, unknown>[];
    partial: string;
    bytesRead: number;
  },
): void {
  // Re-inserting moves the key to the end, so the first key is always the one
  // read longest ago.
  host.sharedTranscriptReads.delete(filePath);
  host.sharedTranscriptReads.set(filePath, entry);
  while (
    host.sharedTranscriptReads.size >
    SHARED_TRANSCRIPT_CACHE_LIMIT
  ) {
    const oldest = host.sharedTranscriptReads.keys().next();
    if (oldest.done) break;
    host.sharedTranscriptReads.delete(oldest.value);
  }
}
