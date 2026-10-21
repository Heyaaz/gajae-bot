import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openLoginShell,
  type PtyProcess,
} from "./terminal-session.js";

class FakePty implements PtyProcess {
  readonly pid = 42;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  pauses = 0;
  resumes = 0;
  readonly signals: Array<string | undefined> = [];
  private dataListener: ((data: string) => void) | undefined;
  private exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;

  write(data: string): void {
    this.writes.push(data);
  }
  resize(columns: number, rows: number): void {
    this.resizes.push([columns, rows]);
  }
  pause(): void {
    this.pauses += 1;
  }
  resume(): void {
    this.resumes += 1;
  }
  kill(signal?: string): void {
    this.signals.push(signal);
  }
  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListener = listener;
    return { dispose: () => undefined };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListener = listener;
    return { dispose: () => undefined };
  }
  emit(data: string): void {
    this.dataListener?.(data);
  }
  emitExit(exitCode: number): void {
    this.exitListener?.({ exitCode, signal: 0 });
  }
}

describe("login shell session", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("tries the next login shell when the first spawn fails", () => {
    const files: string[] = [];
    const pty = new FakePty();
    openLoginShell({
      env: { SHELL: "/no/such-shell" },
      platform: "linux",
      cwd: "/tmp",
      onData: () => undefined,
      onExit: () => undefined,
      spawn: (file, args) => {
        files.push(`${file} ${args.join(" ")}`);
        if (files.length === 1) throw new Error("spawn failed");
        return pty;
      },
    });
    expect(files).toEqual(["/no/such-shell -l", "/bin/bash -l"]);
  });

  it("applies input, clamped resize, and pause/resume frames", () => {
    const pty = new FakePty();
    const output: string[] = [];
    const session = openLoginShell({
      env: { SHELL: "/bin/bash" },
      platform: "linux",
      cols: 80,
      rows: 24,
      onData: (data) => output.push(data),
      onExit: () => undefined,
      spawn: () => pty,
    });
    session.handle({ t: "i", d: "echo hi\r" });
    session.handle({ t: "r", c: 0, r: 4000 });
    session.handle({ t: "p", paused: true });
    session.handle({ t: "p", paused: true });
    pty.emit("hello");
    session.handle({ t: "p", paused: false });
    session.dispose();
    expect(pty.writes).toEqual(["echo hi\r"]);
    expect(pty.resizes).toEqual([[1, 1000]]);
    expect(pty.pauses).toBe(1);
    expect(pty.resumes).toBe(2);
    expect(pty.signals).toEqual([undefined]);
    expect(output).toEqual(["hello"]);
  });

  it("echoes a marker through the real login shell", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gajae-pty-"));
    directories.push(directory);
    let output = "";
    const session = openLoginShell({
      cwd: directory,
      cols: 80,
      rows: 24,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: directory,
        SHELL: "/bin/bash",
        USER: "gajae",
        LOGNAME: "gajae",
        LANG: "C.UTF-8",
      },
      onData: (data) => {
        output += data;
      },
      onExit: () => undefined,
    });
    session.handle({ t: "i", d: "echo gajae-pty-ok\r" });
    const deadline = Date.now() + 8_000;
    while (!output.includes("gajae-pty-ok") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    session.dispose();
    expect(output).toContain("gajae-pty-ok");
  });
});
