import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { GeneratedFilePreview } from "../shared/agent-contract.js";

/**
 * Reads a generated file for the preview pane.
 *
 * The requested path is resolved against the session workspace and must remain
 * inside it; the extension decides which bounded encoding is safe to send.
 */
export async function previewGeneratedFile(
  workspaceDirectory: string,
  requestedPath: string,
): Promise<GeneratedFilePreview> {
  const workspace = await realpath(workspaceDirectory);

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
