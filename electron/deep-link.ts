import path from "node:path";
import type { SessionShortcut } from "../shared/settings-ipc.js";

export const DEEP_LINK_PROTOCOL = "gajae:";
export const DEEP_LINK_PROMPT_LIMIT = 20_000;
const SESSION_ID_LIMIT = 256;

/**
 * What one gajae:// URL asks a window to do. Anything that is not a Gajae link is
 * `undefined` and ignored. A link Gajae recognizes but cannot honour becomes
 * `invalidLink`, so the user who clicked it is told why nothing opened.
 *
 * - `gajae://new?prompt=…&path=…` opens the new-session dialog, never a session.
 * - `gajae://session/<id>` opens a session the window knows.
 */
export function sessionShortcutForDeepLink(
  url: string,
  isDirectory: (candidate: string) => boolean,
): SessionShortcut | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== DEEP_LINK_PROTOCOL) return undefined;
  if (parsed.hostname === "new" && (parsed.pathname === "" || parsed.pathname === "/"))
    return newSessionLink(parsed.searchParams, isDirectory);
  if (parsed.hostname === "session") return openSessionLink(parsed.pathname);
  return undefined;
}

export function deepLinksInArgv(argv: readonly string[]): string[] {
  return argv.filter((argument) => argument.startsWith(`${DEEP_LINK_PROTOCOL}//`));
}

function newSessionLink(
  query: URLSearchParams,
  isDirectory: (candidate: string) => boolean,
): SessionShortcut {
  const prompt = query.get("prompt") ?? "";
  if (prompt.length > DEEP_LINK_PROMPT_LIMIT)
    return { type: "invalidLink", reason: { kind: "prompt", limit: DEEP_LINK_PROMPT_LIMIT } };
  const requested = query.get("path");
  if (requested !== null && !(path.isAbsolute(requested) && isDirectory(requested)))
    return { type: "invalidLink", reason: { kind: "path", path: requested.slice(0, 512) } };
  return {
    type: "new",
    prefill: {
      ...(requested !== null ? { workspace: path.resolve(requested) } : {}),
      ...(prompt.trim() ? { prompt } : {}),
    },
  };
}

function openSessionLink(pathname: string): SessionShortcut {
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(pathname.replace(/^\//u, ""));
  } catch {
    return { type: "invalidLink", reason: { kind: "session" } };
  }
  if (!sessionId || sessionId.length > SESSION_ID_LIMIT || sessionId.includes("/"))
    return { type: "invalidLink", reason: { kind: "session" } };
  return { type: "open", sessionId };
}
