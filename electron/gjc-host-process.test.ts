import { describe, expect, it } from "vitest";
import { gjcHostProcess } from "./gjc-host-process.js";

const reads = (line: string) => async () => line;

describe("gjcHostProcess", () => {
  it("names a terminal GJC and its terminal", async () => {
    expect(await gjcHostProcess(4242, reads("ttys002  gjc\n"))).toEqual({ pid: 4242, terminal: "ttys002" });
    expect(await gjcHostProcess(4242, reads("??  /Users/me/.local/bin/gjc serve --stdio"))).toEqual({ pid: 4242 });
  });

  it("refuses a pid that is gone or now runs something else", async () => {
    expect(await gjcHostProcess(4242, async () => { throw new Error("exit 1"); })).toBeUndefined();
    expect(await gjcHostProcess(4242, reads(""))).toBeUndefined();
    expect(await gjcHostProcess(4242, reads("ttys002  -/bin/zsh"))).toBeUndefined();
    expect(await gjcHostProcess(1, reads("??  gjc"))).toBeUndefined();
  });
});
