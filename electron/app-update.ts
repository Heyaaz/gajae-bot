import type {
  AppUpdateStatus,
  AppUpdateUnknownReason,
  AvailableAppUpdate,
} from "../shared/app-update.js";
import { compareGjcVersions } from "../shared/gjc-version.js";

export interface GithubRepository {
  owner: string;
  repo: string;
}

/** The slice of `fetch` the release check uses, so tests and Electron's `net.fetch` fit. */
export type ReleaseFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const RELEASE_TIMEOUT_MS = 10_000;
const VERSION_TAG = /^v?\d+\.\d+\.\d+/u;

/**
 * The GitHub repository named by package.json's `repository` field.
 *
 * package.json is the one place the repository is written down, so the release
 * check reads it instead of carrying a second copy that could drift.
 */
export function githubRepository(
  repository: unknown,
): GithubRepository | undefined {
  const url =
    typeof repository === "string"
      ? repository
      : repository && typeof repository === "object"
        ? (repository as { url?: unknown }).url
        : undefined;
  if (typeof url !== "string") return undefined;
  const match =
    /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u.exec(url.trim()) ??
    /^(?:github:)?([\w.-]+)\/([\w.-]+)$/u.exec(url.trim());
  if (!match) return undefined;
  return { owner: match[1]!, repo: match[2]! };
}

/**
 * Asks GitHub for the latest published release and compares it with this build.
 *
 * Every failure lands in `unknown`. A private repository answers 404 to an
 * unauthenticated client exactly like one with no release yet, so the two are the
 * same state here.
 */
export async function checkLatestRelease(input: {
  currentVersion: string;
  repository: GithubRepository | undefined;
  fetch: ReleaseFetch;
  now?: () => number;
}): Promise<AppUpdateStatus> {
  const { currentVersion, repository } = input;
  const checkedAtMs = (input.now ?? Date.now)();
  const unknown = (reason: AppUpdateUnknownReason): AppUpdateStatus => ({
    state: "unknown",
    currentVersion,
    reason,
    checkedAtMs,
  });
  if (!repository) return unknown("no-repository");
  let response: Awaited<ReturnType<ReleaseFetch>>;
  try {
    response = await input.fetch(
      `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": `Gajae/${currentVersion}`,
        },
        signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
      },
    );
  } catch {
    return unknown("unreachable");
  }
  if (response.status === 404) return unknown("not-found");
  // Unauthenticated API calls get 60 an hour per address, and GitHub answers an
  // exhausted quota with 403 as often as with 429.
  if (response.status === 403 || response.status === 429)
    return unknown("rate-limited");
  if (response.status < 200 || response.status >= 300)
    return unknown("unreachable");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unknown("invalid-response");
  }
  const release =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const tag = release.tag_name;
  if (typeof tag !== "string" || !VERSION_TAG.test(tag))
    return unknown("invalid-response");
  const latestVersion = tag.replace(/^v/u, "");
  if (compareGjcVersions(latestVersion, currentVersion) <= 0)
    return { state: "current", currentVersion, latestVersion, checkedAtMs };
  const releaseUrl =
    typeof release.html_url === "string" &&
    release.html_url.startsWith(
      `https://github.com/${repository.owner}/${repository.repo}/`,
    )
      ? release.html_url
      : `https://github.com/${repository.owner}/${repository.repo}/releases/tag/${encodeURIComponent(tag)}`;
  return {
    state: "available",
    currentVersion,
    latestVersion,
    releaseUrl,
    checkedAtMs,
  };
}

export interface AppUpdateMonitorOptions {
  currentVersion: string;
  repository: GithubRepository | undefined;
  fetch: ReleaseFetch;
  /** The newest version already announced, kept across launches. */
  announced: { get(): string | undefined; set(version: string): void };
  notify(update: AvailableAppUpdate): void;
  now?: () => number;
}

/**
 * Holds the last release check and announces each newer version exactly once.
 *
 * A version counts as announced once the user has been shown it, by a
 * notification or by a check they ran themselves, so the next automatic check
 * stays quiet about it.
 */
export class AppUpdateMonitor {
  private latest: AppUpdateStatus;
  private inFlight: Promise<AppUpdateStatus> | undefined;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly options: AppUpdateMonitorOptions) {
    this.latest = { state: "unchecked", currentVersion: options.currentVersion };
  }

  status(): AppUpdateStatus {
    return this.latest;
  }

  /** `notify` decides whether a newly found version raises a notification. */
  check(options: { notify: boolean }): Promise<AppUpdateStatus> {
    this.inFlight ??= this.run(options.notify).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /**
   * Checks once shortly after launch and then on an interval, whenever `enabled`
   * says so at that moment, so turning the preference off needs no restart.
   */
  startAutomaticChecks(
    enabled: () => boolean,
    schedule: { firstDelayMs: number; intervalMs: number },
  ): void {
    const tick = () => {
      if (enabled()) void this.check({ notify: true });
    };
    this.timers.push(
      setTimeout(tick, schedule.firstDelayMs),
      setInterval(tick, schedule.intervalMs),
    );
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  private async run(notify: boolean): Promise<AppUpdateStatus> {
    const status = await checkLatestRelease(this.options);
    this.latest = status;
    if (status.state !== "available") return status;
    const announced = this.options.announced.get();
    if (announced && compareGjcVersions(status.latestVersion, announced) <= 0)
      return status;
    // The release was read; failing to record that it was shown must not turn the
    // check into a failure. The cost is announcing it again after a relaunch.
    try {
      this.options.announced.set(status.latestVersion);
    } catch (error) {
      console.error("App update: could not record the announced version", error);
    }
    if (notify) this.options.notify(status);
    return status;
  }
}
