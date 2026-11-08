import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteSessionThroughCli,
  type CliDeleteTerminal,
} from "./gjc-cli-session-delete.js";

const EDITOR = "\x1b[38;2;255;59;48m│ > Type your message... ⌥Q: Queue\x1b[0m";
const ONBOARDING =
  "Frictionless onboarding\r\n❯ Analyze supported local evidence\r\nLater\r\n↑/↓ select · Enter choose · Esc cancel";
const COMPLETION =
  "│ > /session delete │\r\n❯ delete  Delete current session transcript and artifacts";
const prompt = (selected: "Yes" | "No") =>
  `Delete current session transcript and artifacts?\r\n${selected === "Yes" ? "❯ Yes\r\n  No" : "  Yes\r\n❯ No"}\r\nup/down navigate  enter select  esc cancel`;

/** A stand-in for GJC's TUI: each key it receives may print the next screen. */
function fakeGjc(
  react: (
    keys: string,
    screen: (text: string) => void,
    exit: () => void,
    sent: string[],
  ) => void,
  { ignoresTerm = false } = {},
) {
  const data: Array<(text: string) => void> = [];
  const exits: Array<(event: { exitCode: number }) => void> = [];
  const sent: string[] = [];
  const kills: string[] = [];
  const screen = (text: string) => data.forEach((listener) => listener(text));
  const exit = () => exits.forEach((listener) => listener({ exitCode: 0 }));
  const terminal: CliDeleteTerminal = {
    write: (keys) => {
      sent.push(keys);
      react(keys, screen, exit, sent);
    },
    kill: (signal) => {
      kills.push(signal ?? "SIGHUP");
      if (signal === "SIGKILL" || !ignoresTerm) exit();
    },
    onData: (listener) => {
      data.push(listener);
      return { dispose: () => data.splice(data.indexOf(listener), 1) };
    },
    onExit: (listener) => {
      exits.push(listener);
      return { dispose: () => exits.splice(exits.indexOf(listener), 1) };
    },
  };
  const spawn = vi.fn(() => {
    setTimeout(() => screen(EDITOR), 50);
    return terminal;
  });
  return { spawn, sent, kills, screen };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("deleteSessionThroughCli", () => {
  it.each(["before", "after"])(
    "dismisses a model selector opened %s command entry without submitting its filter",
    async (opening) => {
      let transcript = true;
      let pickerOpen = opening === "before";
      let pickerShown = pickerOpen;
      const picker =
        "Models: ALL CANONICAL (tab to cycle)\r\n> /session delete\r\nNo models available";
      const gjc = fakeGjc((keys, screen) => {
        if (!pickerShown && keys === "/session delete") {
          pickerShown = pickerOpen = true;
          screen(picker);
        } else if (pickerOpen) {
          expect(keys).toBe("\x1b");
          pickerOpen = false;
          screen(EDITOR);
        } else if (keys === "/session delete") screen(COMPLETION);
        else if (
          keys === "\r" &&
          gjc.sent.filter((key) => key === "\r").length === 1
        )
          screen(prompt("Yes"));
        else if (keys === "\r") {
          transcript = false;
          screen("Current session transcript and artifacts deleted");
        }
      });
      const deletion = deleteSessionThroughCli({
        executable: "/bin/gjc",
        cwd: "/repo",
        sessionPath: "/s1.jsonl",
        env: {},
        spawn: gjc.spawn,
        transcriptExists: async () => transcript,
      });
      if (opening === "before") setTimeout(() => gjc.screen(picker), 100);
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(deletion).resolves.toBeUndefined();
      expect(gjc.sent).toEqual([
        ...(opening === "after" ? ["/session delete"] : []),
        "\x1b",
        "/session delete",
        "\r",
        "\r",
      ]);
    },
  );

  it("answers split terminal queries without losing fresh screens or starving quiet time", async () => {
    let transcript = true;
    const gjc = fakeGjc((keys, screen) => {
      if (keys === "/session delete") screen(COMPLETION);
      else if (
        keys === "\r" &&
        gjc.sent.filter((key) => key === "\r").length === 1
      )
        screen(prompt("Yes"));
      else if (keys === "\r") {
        transcript = false;
        screen("Current session transcript and artifacts deleted");
      }
    });
    const deletion = deleteSessionThroughCli({
      executable: "/bin/gjc",
      cwd: "/repo",
      sessionPath: "/s1.jsonl",
      env: {},
      spawn: gjc.spawn,
      transcriptExists: async () => transcript,
      quietMs: 500,
      timeoutMs: 5_000,
    });
    const queries = setInterval(() => {
      gjc.screen("\x1b]11;");
      gjc.screen("?\x07\x1b[");
      gjc.screen("c");
    }, 100);
    await vi.advanceTimersByTimeAsync(4_000);
    clearInterval(queries);
    await expect(deletion).resolves.toBeUndefined();
    expect(gjc.sent.filter((key) => key !== "\x1b[?1;2c")).toEqual([
      "/session delete",
      "\r",
      "\r",
    ]);
    expect(
      gjc.sent.filter((key) => key === "\x1b[?1;2c").length,
    ).toBeGreaterThan(3);
    expect(gjc.kills).toEqual(["SIGTERM"]);
  });

  it("responds once per DA1 query and does not interpret a query inside another OSC as a probe", async () => {
    const gjc = fakeGjc(() => undefined);
    const deletion = deleteSessionThroughCli({
      executable: "/bin/gjc",
      cwd: "/repo",
      sessionPath: "/s1.jsonl",
      env: {},
      spawn: gjc.spawn,
      transcriptExists: async () => true,
      timeoutMs: 2_000,
    });
    const outcome = expect(deletion).rejects.toMatchObject({
      reason: "timeout",
      stage: "typed",
    });
    gjc.screen("\x1b]0;title \x1b[c\x07\x1b]11;?\x1b");
    gjc.screen("\\\x1b[c\x1b[c");
    await vi.advanceTimersByTimeAsync(3_000);
    await outcome;
    expect(gjc.sent).toEqual(["\x1b[?1;2c", "\x1b[?1;2c", "/session delete"]);
  });

  it("does not confirm a No-selected prompt after a terminal query", async () => {
    const gjc = fakeGjc((keys, screen) => {
      if (keys === "/session delete") screen(COMPLETION);
      else if (keys === "\r") screen(`${prompt("No")}\x1b]11;?\x07\x1b[c`);
    });
    const deletion = deleteSessionThroughCli({
      executable: "/bin/gjc",
      cwd: "/repo",
      sessionPath: "/s1.jsonl",
      env: {},
      spawn: gjc.spawn,
      transcriptExists: async () => true,
    });
    const outcome = expect(deletion).rejects.toMatchObject({
      reason: "unexpected-dialog",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(gjc.sent).toEqual(["/session delete", "\r", "\x1b[?1;2c"]);
  });

  it("dismisses a startup dialog, submits through the completion list and confirms GJC's own prompt", async () => {
    let transcript = true;
    let onboardingShown = false;
    const gjc = fakeGjc((keys, screen) => {
      if (keys === "/session delete" && !onboardingShown) {
        onboardingShown = true;
        screen(COMPLETION);
        setTimeout(() => screen(ONBOARDING), 100);
      } else if (keys === "\x1b") screen(EDITOR);
      else if (keys === "/session delete") screen(COMPLETION);
      else if (
        keys === "\r" &&
        gjc.sent.filter((key) => key === "\r").length === 1
      )
        screen("│ > /session delete │");
      else if (
        keys === "\r" &&
        gjc.sent.filter((key) => key === "\r").length === 2
      )
        screen(prompt("Yes"));
      else if (keys === "\r") {
        transcript = false;
        screen(
          "Current session transcript and artifacts deleted\r\nResume Session",
        );
      }
    });
    const deletion = deleteSessionThroughCli({
      executable: "/bin/gjc",
      cwd: "/repo",
      sessionPath: "/agent/sessions/x/s1.jsonl",
      env: { PATH: "/usr/bin", EMPTY: undefined },
      spawn: gjc.spawn,
      transcriptExists: async () => transcript,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(deletion).resolves.toBeUndefined();
    expect(gjc.spawn).toHaveBeenCalledWith(
      "/bin/gjc",
      ["--resume", "/agent/sessions/x/s1.jsonl", "--no-mcp", "--no-lsp"],
      expect.objectContaining({
        cwd: "/repo",
        env: { PATH: "/usr/bin", TERM: "xterm-256color", GJC_AUTOMATION: "1" },
      }),
    );
    expect(gjc.sent).toEqual([
      "/session delete",
      "\x1b",
      "/session delete",
      "\r",
      "\r",
      "\r",
    ]);
    expect(gjc.kills).toEqual(["SIGTERM"]);
  });

  it("starts over in a new GJC when GJC refuses because a migration is still running", async () => {
    let transcript = true;
    let runs = 0;
    const gjc = fakeGjc((keys, screen) => {
      if (keys === "/session delete") screen(COMPLETION);
      else if (keys === "\r" && gjc.sent.at(-2) === "/session delete")
        screen(prompt("Yes"));
      else if (keys === "\r" && runs === 1)
        screen(
          "Error: Another session migration is still active. Wait for it to finish, then retry.",
        );
      else if (keys === "\r") {
        transcript = false;
        screen("Current session transcript and artifacts deleted");
      }
    });
    const spawn = vi.fn((...args: Parameters<typeof gjc.spawn>) => {
      runs += 1;
      return gjc.spawn(...args);
    });
    const deletion = deleteSessionThroughCli({
      executable: "/bin/gjc",
      cwd: "/repo",
      sessionPath: "/s1.jsonl",
      env: {},
      spawn,
      transcriptExists: async () => transcript,
    });
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(deletion).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
    // The first GJC is stopped before the second starts; no key reaches it again.
    expect(gjc.kills).toEqual(["SIGTERM", "SIGTERM"]);
    expect(gjc.sent).toEqual([
      "/session delete",
      "\r",
      "\r",
      "/session delete",
      "\r",
      "\r",
    ]);
  });

  it("keeps GJC running after the transcript is gone until GJC reports the deletion", async () => {
    let transcript = true;
    const gjc = fakeGjc((keys, screen) => {
      if (keys === "/session delete") screen(COMPLETION);
      else if (keys === "\r" && gjc.sent.at(-2) === "/session delete")
        screen(prompt("Yes"));
      else if (keys === "\r") {
        // The transcript goes first; the store lock is released and reported later.
        transcript = false;
        setTimeout(
          () =>
            screen(
              "\x1b[2mCurrent session transcript and artifacts deleted\x1b[0m",
            ),
          4_000,
        );
      }
    });
    const deletion = deleteSessionThroughCli({
      executable: "/bin/gjc",
      cwd: "/repo",
      sessionPath: "/s1.jsonl",
      env: {},
      spawn: gjc.spawn,
      transcriptExists: async () => transcript,
    });
    let settled = false;
    void deletion.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(transcript).toBe(false);
    expect(gjc.kills).toEqual([]);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(deletion).resolves.toBeUndefined();
    expect(gjc.kills).toEqual(["SIGTERM"]);
  });

  it("stops GJC a grace period after the transcript is gone when no report comes", async () => {
    let transcript = true;
    let goneAt = 0;
    let stoppedAt = 0;
    const gjc = fakeGjc((keys, screen) => {
      if (keys === "/session delete") screen(COMPLETION);
      else if (keys === "\r" && gjc.sent.at(-2) === "/session delete")
        screen(prompt("Yes"));
      else if (keys === "\r") {
        transcript = false;
        goneAt = Date.now();
      }
    });
    const spawn = vi.fn((...args: Parameters<typeof gjc.spawn>) => {
      const terminal = gjc.spawn(...args);
      return {
        ...terminal,
        kill: (signal?: string) => {
          stoppedAt ||= Date.now();
          terminal.kill(signal);
        },
      };
    });
    const deletion = deleteSessionThroughCli({
      executable: "/bin/gjc",
      cwd: "/repo",
      sessionPath: "/s1.jsonl",
      env: {},
      spawn,
      transcriptExists: async () => transcript,
      completionGraceMs: 3_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(deletion).resolves.toBeUndefined();
    expect(stoppedAt - goneAt).toBeGreaterThanOrEqual(3_000);
    expect(stoppedAt - goneAt).toBeLessThan(3_500);
  });

  it("counts a deletion whose transcript is gone as done when the overall time runs out", async () => {
    let transcript = true;
    const gjc = fakeGjc((keys, screen) => {
      if (keys === "/session delete") screen(COMPLETION);
      else if (keys === "\r" && gjc.sent.at(-2) === "/session delete")
        screen(prompt("Yes"));
      else if (keys === "\r") transcript = false;
    });
    const deletion = deleteSessionThroughCli({
      executable: "/bin/gjc",
      cwd: "/repo",
      sessionPath: "/s1.jsonl",
      env: {},
      spawn: gjc.spawn,
      transcriptExists: async () => transcript,
      timeoutMs: 6_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(deletion).resolves.toBeUndefined();
    expect(gjc.kills).toEqual(["SIGTERM"]);
  });

  it("never answers a deletion prompt that does not have Yes selected", async () => {
    const gjc = fakeGjc((keys, screen) => {
      if (keys === "/session delete") screen(COMPLETION);
      else if (keys === "\r") screen(prompt("No"));
    });
    const deletion = deleteSessionThroughCli({
      executable: "/bin/gjc",
      cwd: "/repo",
      sessionPath: "/s1.jsonl",
      env: {},
      spawn: gjc.spawn,
      transcriptExists: async () => true,
    });
    const outcome = expect(deletion).rejects.toMatchObject({
      reason: "unexpected-dialog",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    expect(gjc.sent).toEqual(["/session delete", "\r"]);
    expect(gjc.kills).toEqual(["SIGTERM"]);
  });

  it("stops GJC and keeps the session when the deletion never completes", async () => {
    const gjc = fakeGjc(() => undefined, { ignoresTerm: true });
    const deletion = deleteSessionThroughCli({
      executable: "/bin/gjc",
      cwd: "/repo",
      sessionPath: "/s1.jsonl",
      env: {},
      spawn: gjc.spawn,
      transcriptExists: async () => true,
      timeoutMs: 5_000,
    });
    const outcome = expect(deletion).rejects.toMatchObject({
      reason: "timeout",
      stage: "typed",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    // Nothing echoed the command, so no Enter could know where it would land.
    expect(gjc.sent).toEqual(["/session delete"]);
    expect(gjc.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("sends no Enter into a selection list that is not the command's completion", async () => {
    const gjc = fakeGjc((keys, screen) => {
      if (keys === "/session delete")
        screen(
          `${COMPLETION}\r\nWhich GJC workflow do you want help with?\r\n❯ Analyze supported local evidence`,
        );
    });
    const deletion = deleteSessionThroughCli({
      executable: "/bin/gjc",
      cwd: "/repo",
      sessionPath: "/s1.jsonl",
      env: {},
      spawn: gjc.spawn,
      transcriptExists: async () => true,
      timeoutMs: 5_000,
    });
    const outcome = expect(deletion).rejects.toMatchObject({
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    expect(gjc.sent).toEqual(["/session delete"]);
  });

  it("reports GJC exiting before the transcript is gone", async () => {
    const gjc = fakeGjc((keys, _screen, exit) => {
      if (keys === "/session delete") exit();
    });
    const deletion = deleteSessionThroughCli({
      executable: "/bin/gjc",
      cwd: "/repo",
      sessionPath: "/s1.jsonl",
      env: {},
      spawn: gjc.spawn,
      transcriptExists: async () => true,
    });
    const outcome = expect(deletion).rejects.toMatchObject({
      reason: "exited",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(gjc.kills).toEqual([]);
  });
});
