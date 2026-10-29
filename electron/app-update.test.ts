import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppUpdateMonitor,
  checkLatestRelease,
  githubRepository,
  type ReleaseFetch,
} from "./app-update.js";
import { DesktopStateStore } from "./desktop-state-store.js";

const repository = { owner: "Heyaaz", repo: "gajae-bot" };

function answering(status: number, body: unknown = {}): ReleaseFetch {
  return vi.fn(async () => ({ status, json: async () => body }));
}

function release(tag: string) {
  return {
    tag_name: tag,
    html_url: `https://github.com/Heyaaz/gajae-bot/releases/tag/${tag}`,
  };
}

describe("githubRepository", () => {
  it("reads the repository this package.json names", () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { repository: unknown };
    expect(githubRepository(packageJson.repository)).toEqual(repository);
  });

  it("accepts the URL forms npm writes and refuses anything else", () => {
    for (const url of [
      "https://github.com/Heyaaz/gajae-bot.git",
      "git+https://github.com/Heyaaz/gajae-bot.git",
      "git@github.com:Heyaaz/gajae-bot.git",
      "github:Heyaaz/gajae-bot",
      "Heyaaz/gajae-bot",
    ])
      expect(githubRepository({ url })).toEqual(repository);
    expect(githubRepository(undefined)).toBeUndefined();
    expect(githubRepository({ url: "https://gitlab.com/a/b/c" })).toBeUndefined();
  });
});

describe("checkLatestRelease", () => {
  const check = (fetch: ReleaseFetch, currentVersion = "0.1.0") =>
    checkLatestRelease({ currentVersion, repository, fetch, now: () => 5 });

  it("asks the latest-release endpoint of the named repository", async () => {
    const fetch = answering(200, release("v0.1.0"));
    await check(fetch);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/Heyaaz/gajae-bot/releases/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("offers a newer release with its page and stays current otherwise", async () => {
    await expect(check(answering(200, release("v0.2.0")))).resolves.toEqual({
      state: "available",
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      releaseUrl: "https://github.com/Heyaaz/gajae-bot/releases/tag/v0.2.0",
      checkedAtMs: 5,
    });
    await expect(check(answering(200, release("0.1.0")))).resolves.toMatchObject({
      state: "current",
      latestVersion: "0.1.0",
    });
    await expect(
      check(answering(200, release("v0.1.0")), "0.2.0"),
    ).resolves.toMatchObject({ state: "current" });
  });

  it("does not trust a release page outside the repository", async () => {
    const status = await check(
      answering(200, { tag_name: "v0.2.0", html_url: "https://evil.example/x" }),
    );
    expect(status).toMatchObject({
      releaseUrl: "https://github.com/Heyaaz/gajae-bot/releases/tag/v0.2.0",
    });
  });

  it("lands every failure in the quiet unknown state", async () => {
    const failing: ReleaseFetch = async () => {
      throw new TypeError("fetch failed");
    };
    const cases: Array<[ReleaseFetch, string]> = [
      [answering(404), "not-found"],
      [answering(403), "rate-limited"],
      [answering(429), "rate-limited"],
      [answering(500), "unreachable"],
      [failing, "unreachable"],
      [answering(200, { tag_name: "nightly" }), "invalid-response"],
      [
        vi.fn(async () => ({
          status: 200,
          json: async () => {
            throw new SyntaxError("bad json");
          },
        })),
        "invalid-response",
      ],
    ];
    for (const [fetch, reason] of cases)
      await expect(check(fetch)).resolves.toEqual({
        state: "unknown",
        currentVersion: "0.1.0",
        reason,
        checkedAtMs: 5,
      });
    await expect(
      checkLatestRelease({ currentVersion: "0.1.0", repository: undefined, fetch: answering(200) }),
    ).resolves.toMatchObject({ state: "unknown", reason: "no-repository" });
  });
});

describe("AppUpdateMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function monitor(fetch: ReleaseFetch, userData = mkdtempSync(path.join(tmpdir(), "gajae-update-"))) {
    const store = new DesktopStateStore(userData);
    const notify = vi.fn();
    const updates = new AppUpdateMonitor({
      currentVersion: "0.1.0",
      repository,
      fetch,
      announced: {
        get: () => store.get().announcedAppVersion,
        set: (version) => store.update({ announcedAppVersion: version }),
      },
      notify,
    });
    return { updates, notify, userData };
  }

  it("announces a new version once, across launches", async () => {
    const first = monitor(answering(200, release("v0.2.0")));
    await first.updates.check({ notify: true });
    await first.updates.check({ notify: true });
    expect(first.notify).toHaveBeenCalledTimes(1);
    expect(first.notify).toHaveBeenCalledWith(
      expect.objectContaining({ latestVersion: "0.2.0" }),
    );

    const relaunched = monitor(answering(200, release("v0.2.0")), first.userData);
    await relaunched.updates.check({ notify: true });
    expect(relaunched.notify).not.toHaveBeenCalled();

    const newer = monitor(answering(200, release("v0.3.0")), first.userData);
    await newer.updates.check({ notify: true });
    expect(newer.notify).toHaveBeenCalledTimes(1);
  });

  it("treats a version the user checked for by hand as already announced", async () => {
    const { updates, notify } = monitor(answering(200, release("v0.2.0")));
    await expect(updates.check({ notify: false })).resolves.toMatchObject({
      state: "available",
    });
    await updates.check({ notify: true });
    expect(notify).not.toHaveBeenCalled();
  });

  it("stays quiet and keeps the status when the release cannot be read", async () => {
    const { updates, notify } = monitor(answering(404));
    expect(updates.status()).toEqual({ state: "unchecked", currentVersion: "0.1.0" });
    await updates.check({ notify: true });
    expect(updates.status()).toMatchObject({ state: "unknown", reason: "not-found" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("shares one request between overlapping checks", async () => {
    const fetch = answering(200, release("v0.1.0"));
    const { updates } = monitor(fetch);
    await Promise.all([updates.check({ notify: true }), updates.check({ notify: false })]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks on schedule only while the preference allows it", async () => {
    vi.useFakeTimers();
    const fetch = answering(200, release("v0.1.0"));
    const { updates } = monitor(fetch);
    let enabled = false;
    updates.startAutomaticChecks(() => enabled, { firstDelayMs: 10, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(10);
    expect(fetch).not.toHaveBeenCalled();
    enabled = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    updates.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
