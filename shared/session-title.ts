/** The title a session carries until its first request names it. */
export const DEFAULT_SESSION_TITLE = "새 세션";

/** Sessions created before the rename still carry this title. */
const LEGACY_DEFAULT_SESSION_TITLE = "새 Gajae 세션";

export function isDefaultSessionTitle(title: string | undefined): boolean {
  return title === DEFAULT_SESSION_TITLE || title === LEGACY_DEFAULT_SESSION_TITLE;
}
