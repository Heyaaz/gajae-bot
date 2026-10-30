import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSessionThroughCli, type CliDeleteTerminal } from "./gjc-cli-session-delete.js";

const EDITOR = "\x1b[38;2;255;59;48m│ > Type your message... ⌥Q: Queue\x1b[0m";
const ONBOARDING = "Frictionless onboarding\r\n❯ Analyze supported local evidence\r\nLater\r\n↑/↓ select · Enter choose · Esc cancel";
const COMPLETION = "│ > /session delete │\r\n❯ delete  Delete current session transcript and artifacts";
const prompt = (selected: "Yes" | "No") =>
  `Delete current session transcript and artifacts?\r\n${selected === "Yes" ? "❯ Yes\r\n  No" : "  Yes\r\n❯ No"}\r\nup/down navigate  enter select  esc cancel`;

/** A stand-in for GJC's TUI: each key it receives may print the next screen. */
function fakeGjc(
  react: (keys: string, screen: (text: string) => void, exit: () => void, sent: string[]) => void,
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
      else if (keys === "\r" && gjc.sent.filter((key) => key === "\r").length === 1) screen("│ > /session delete │");
      else if (keys === "\r" && gjc.sent.filter((key) => key === "\r").length === 2) screen(prompt("Yes"));
      else if (keys === "\r") {
        transcript = false;
        screen("Current session transcript and artifacts deleted\r\nResume Session");
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
      expect.objectContaining({ cwd: "/repo", env: { PATH: "/usr/bin", TERM: "xterm-256color", GJC_AUTOMATION: "1" } }),
    );
    expect(gjc.sent).toEqual(["/session delete", "\x1b", "/session delete", "\r", "\r", "\r"]);
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
    const outcome = expect(deletion).rejects.toMatchObject({ reason: "unexpected-dialog" });
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
    const outcome = expect(deletion).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    // Nothing echoed the command, so no Enter could know where it would land.
    expect(gjc.sent).toEqual(["/session delete"]);
    expect(gjc.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("sends no Enter into a selection list that is not the command's completion", async () => {
    const gjc = fakeGjc((keys, screen) => {
      if (keys === "/session delete") screen(`${COMPLETION}\r\nWhich GJC workflow do you want help with?\r\n❯ Analyze supported local evidence`);
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
    const outcome = expect(deletion).rejects.toMatchObject({ reason: "timeout" });
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
    const outcome = expect(deletion).rejects.toMatchObject({ reason: "exited" });
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(gjc.kills).toEqual([]);
  });
});
