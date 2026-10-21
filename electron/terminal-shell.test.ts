import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clampTerminalDimension,
  loginShellPlan,
  resolveShellCwd,
} from "./terminal-shell.js";

describe("login shell plan", () => {
  it("starts SHELL as a login shell and falls back to bash then sh", () => {
    expect(loginShellPlan({ SHELL: "/bin/zsh" }, "linux")).toEqual([
      { file: "/bin/zsh", args: ["-l"] },
      { file: "/bin/bash", args: ["-l"] },
      { file: "/bin/sh", args: ["-l"] },
    ]);
    expect(loginShellPlan({ SHELL: "zsh" }, "darwin").map((command) => command.file)).toEqual([
      "zsh",
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
    ]);
  });

  it("rejects an unsafe SHELL and keeps the platform fallback", () => {
    expect(loginShellPlan({ SHELL: "/bin/zsh\n/tmp/evil" }, "linux").map((command) => command.file)).toEqual([
      "/bin/bash",
      "/bin/sh",
    ]);
    expect(loginShellPlan({}, "linux").map((command) => command.file)).toEqual(["/bin/bash", "/bin/sh"]);
  });

  it("uses the Windows login-shell analogue", () => {
    expect(
      loginShellPlan(
        { COMSPEC: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
        "win32",
      )[0],
    ).toEqual({
      file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo"],
    });
  });

  it("clamps resize dimensions the way the pty host does", () => {
    expect(clampTerminalDimension(0)).toBe(1);
    expect(clampTerminalDimension(-4)).toBe(1);
    expect(clampTerminalDimension("12")).toBe(12);
    expect(clampTerminalDimension(5000)).toBe(1000);
    expect(clampTerminalDimension("nope")).toBe(1);
  });

  it("keeps an existing directory and otherwise uses the fallback", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-shell-cwd-"));
    expect(resolveShellCwd(directory, "/no/such")).toBe(directory);
    expect(resolveShellCwd("/no/such", directory)).toBe(directory);
    expect(resolveShellCwd("relative", directory)).toBe(directory);
  });
});
