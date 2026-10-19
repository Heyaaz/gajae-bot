import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The shell's polling effects cannot be driven from Node -- importing the renderer
 * needs a DOM -- so this asserts the shape of the source instead: every interval
 * that talks to the backend is gated on visibility and paired with a
 * `visibilitychange` listener that catches up afterwards.
 *
 * The gating matters because run state now arrives on its own from the transcript
 * watchers at 161ms. Polling a hidden window only discovers sessions nobody can
 * see yet, at 240 broker scans an hour.
 */
const source = readFileSync(
  path.join(import.meta.dirname, "shell.tsx"),
  "utf8",
);

function intervalBodies(text: string): string[] {
  const bodies: string[] = [];
  const marker = "setInterval(";
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
    // Take the argument list by balancing parentheses so a nested call does not
    // truncate the body.
    let depth = 0;
    let end = at + marker.length - 1;
    for (; end < text.length; end += 1) {
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(text.slice(at, end + 1));
  }
  return bodies;
}

describe("shell polling while the window is hidden", () => {
  it("gates every backend poll on the window being visible", () => {
    const bodies = intervalBodies(source);
    // Guards the parse itself: finding no intervals would pass vacuously.
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    for (const body of bodies) expect(body).toContain("document.hidden");
  });

  it("catches up when the window comes back", () => {
    // Gating alone would leave a window stale for a whole interval after it is
    // shown again. One listener now catches up both beats in the same effect, so
    // assert the listener exists, calls the shared refresh, and is torn down.
    const listeners = source.match(
      /document\.addEventListener\("visibilitychange"/gu,
    );
    const removals = source.match(
      /document\.removeEventListener\("visibilitychange"/gu,
    );
    expect(listeners?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(source).toContain("if (!document.hidden) refreshVisibleState();");
    // Every listener is torn down with its effect.
    expect(removals?.length ?? 0).toBe(listeners?.length ?? 0);
  });
});
