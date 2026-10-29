/**
 * What the app knows about a newer Gajae release.
 *
 * `unknown` is a normal outcome, not an error: an unpublished or private
 * repository, no network and GitHub's rate limit all end there, and none of them
 * may block the app or raise a notification.
 */
export type AppUpdateStatus =
  | { state: "unchecked"; currentVersion: string }
  | {
      state: "current";
      currentVersion: string;
      latestVersion: string;
      checkedAtMs: number;
    }
  | {
      state: "available";
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
      checkedAtMs: number;
    }
  | {
      state: "unknown";
      currentVersion: string;
      reason: AppUpdateUnknownReason;
      checkedAtMs: number;
    };

export type AppUpdateUnknownReason =
  | "no-repository"
  | "not-found"
  | "rate-limited"
  | "unreachable"
  | "invalid-response";

export type AvailableAppUpdate = Extract<AppUpdateStatus, { state: "available" }>;
