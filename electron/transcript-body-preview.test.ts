import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_BODY_ARTIFACT_PREFIX,
  type ToolActivity,
  type TranscriptItem,
} from "../shared/agent-contract.js";
import {
  projectTranscriptItemForDelivery,
  resolveTranscriptBodyArtifact,
} from "./transcript-body-preview.js";

const PREVIEW_MARKER = "\n\n[Preview truncated; full content available as artifact]";

function tool(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: "tool-1",
    kind: "tool",
    sessionId: "session-1",
    name: "bash",
    description: "Run command",
    status: "completed",
    createdAt: "now",
    ...overrides,
  };
}

describe("transcript body delivery projection", () => {
  it("bounds command and output prefixes by UTF-8 bytes without splitting emoji", () => {
    const command = `${"😀".repeat(257)}tail`;
    const output = `${"😀".repeat(513)}tail`;
    const projected = projectTranscriptItemForDelivery(tool({ command, output }));

    expect(projected.kind).toBe("tool");
    if (projected.kind !== "tool") throw new Error("Expected tool row");
    expect(projected.command).toBe(`${"😀".repeat(64)}${PREVIEW_MARKER}`);
    expect(projected.output).toBe(`${"😀".repeat(128)}${PREVIEW_MARKER}`);
    expect(Buffer.byteLength(projected.command!.slice(0, -PREVIEW_MARKER.length))).toBe(256);
    expect(Buffer.byteLength(projected.output!.slice(0, -PREVIEW_MARKER.length))).toBe(512);
  });

  it("recovers the exact command and output text from authoritative rows", () => {
    const original = tool({
      command: `echo ${"command-😀".repeat(180)}`,
      output: `result ${"output-😀".repeat(400)}`,
    });
    const projected = projectTranscriptItemForDelivery(original);
    if (projected.kind !== "tool") throw new Error("Expected tool row");

    const inputArtifact = resolveTranscriptBodyArtifact(
      original.sessionId,
      projected.inputArtifactId!,
      [original],
    );
    const outputArtifact = resolveTranscriptBodyArtifact(
      original.sessionId,
      projected.outputArtifactId!,
      [original],
    );
    expect(inputArtifact).toEqual({
      artifactId: projected.inputArtifactId,
      text: original.command,
      complete: true,
      totalBytes: Buffer.byteLength(original.command!, "utf8"),
    });
    expect(outputArtifact).toEqual({
      artifactId: projected.outputArtifactId,
      text: original.output,
      complete: true,
      totalBytes: Buffer.byteLength(original.output!, "utf8"),
    });
  });

  it("uses stable content-addressed references that change with row identity or content", () => {
    const first = tool({ output: "same-body".repeat(400) });
    const same = projectTranscriptItemForDelivery({ ...first });
    const differentContent = projectTranscriptItemForDelivery({
      ...first,
      output: `${first.output}different`,
    });
    const differentRow = projectTranscriptItemForDelivery({
      ...first,
      id: "tool-2",
    });
    const sameContent = projectTranscriptItemForDelivery(first);

    expect(same.kind).toBe("tool");
    expect(differentContent.kind).toBe("tool");
    expect(differentRow.kind).toBe("tool");
    expect(sameContent.kind).toBe("tool");
    if (
      same.kind !== "tool" ||
      differentContent.kind !== "tool" ||
      differentRow.kind !== "tool" ||
      sameContent.kind !== "tool"
    ) {
      throw new Error("Expected tool rows");
    }
    expect(same.outputArtifactId).toBe(sameContent.outputArtifactId);
    expect(differentContent.outputArtifactId).not.toBe(same.outputArtifactId);
    expect(differentRow.outputArtifactId).not.toBe(same.outputArtifactId);
    expect(same.outputArtifactId).toMatch(
      new RegExp(`^${TRANSCRIPT_BODY_ARTIFACT_PREFIX}output-[0-9a-f]{64}-[0-9a-f]{64}$`, "u"),
    );
    expect(same.outputArtifactId!.length).toBeLessThan(256);
  });

  it("rejects cross-session, changed-body, and dropped-row references as stale", () => {
    const original = tool({ output: "original".repeat(400) });
    const projected = projectTranscriptItemForDelivery(original);
    if (projected.kind !== "tool") throw new Error("Expected tool row");
    const artifactId = projected.outputArtifactId!;

    expect(() =>
      resolveTranscriptBodyArtifact("other-session", artifactId, [original]),
    ).toThrow(/stale transcript body artifact reference/iu);
    expect(() =>
      resolveTranscriptBodyArtifact(original.sessionId, artifactId, [
        { ...original, output: `${original.output}changed` },
      ]),
    ).toThrow(/stale transcript body artifact reference/iu);
    expect(() =>
      resolveTranscriptBodyArtifact(original.sessionId, artifactId, []),
    ).toThrow(/stale transcript body artifact reference/iu);
  });

  it("rejects malformed references in its namespace and ignores other namespaces", () => {
    expect(() =>
      resolveTranscriptBodyArtifact("session-1", `${TRANSCRIPT_BODY_ARTIFACT_PREFIX}bad`, []),
    ).toThrow(/malformed transcript body artifact reference/iu);
    expect(resolveTranscriptBodyArtifact("session-1", "runtime-artifact-1", [])).toBeUndefined();
  });

  it("does not mutate authoritative rows and is idempotent after projection", () => {
    const original = tool({ command: "c".repeat(1100), output: "o".repeat(2200) });
    const originalCommand = original.command;
    const originalOutput = original.output;
    const projected = projectTranscriptItemForDelivery(original);
    const repeated = projectTranscriptItemForDelivery(projected);

    expect(original.command).toBe(originalCommand);
    expect(original.output).toBe(originalOutput);
    expect(projected).not.toBe(original);
    expect(repeated).toBe(projected);
  });

  it("preserves existing artifact ids while bounding large fields", () => {
    const original = tool({
      command: "c".repeat(1100),
      output: "o".repeat(2200),
      inputArtifactId: "runtime-input-1",
      outputArtifactId: "runtime-output-1",
    });
    const projected = projectTranscriptItemForDelivery(original);

    expect(projected.kind).toBe("tool");
    if (projected.kind !== "tool") throw new Error("Expected tool row");
    expect(projected.inputArtifactId).toBe("runtime-input-1");
    expect(projected.outputArtifactId).toBe("runtime-output-1");
    expect(projected.command).toContain(PREVIEW_MARKER);
    expect(projected.output).toContain(PREVIEW_MARKER);
  });

  it("leaves active and approval-phase tools, as well as small rows, untouched", () => {
    const exactLimits = tool({
      command: "c".repeat(1024),
      output: "o".repeat(2048),
    });
    expect(projectTranscriptItemForDelivery(exactLimits)).toBe(exactLimits);

    const activeStatuses: ToolActivity["status"][] = [
      "pending",
      "running",
      "approval-required",
      "approved",
    ];
    for (const status of activeStatuses) {
      const original = tool({ status, command: "c".repeat(1200), output: "o".repeat(2400) });
      expect(projectTranscriptItemForDelivery(original)).toBe(original);
    }

    const small = tool({ command: "small command", output: "small output" });
    expect(projectTranscriptItemForDelivery(small)).toBe(small);
    const settledStatuses: ToolActivity["status"][] = [
      "completed",
      "failed",
      "cancelled",
      "denied",
    ];
    for (const status of settledStatuses) {
      const original = tool({ status, output: "o".repeat(2200) });
      const projected = projectTranscriptItemForDelivery(original);
      expect(projected).not.toBe(original);
      expect(projected.kind === "tool" && projected.outputArtifactId).toBeTruthy();
    }

    const other: TranscriptItem = {
      id: "message-1",
      kind: "message",
      sessionId: "session-1",
      role: "assistant",
      content: "unchanged",
      createdAt: "now",
    };
    expect(projectTranscriptItemForDelivery(other)).toBe(other);
  });

  it("materially reduces a large page while retaining full-body resolution", () => {
    const originalRows = Array.from({ length: 903 }, (_, index) =>
      tool({ id: `tool-${index}`, output: `row-${index}:${"x".repeat(2400)}` }),
    );
    const projectedRows = originalRows.map(projectTranscriptItemForDelivery);
    const originalBytes = Buffer.byteLength(JSON.stringify(originalRows), "utf8");
    const projectedBytes = Buffer.byteLength(JSON.stringify(projectedRows), "utf8");
    const first = projectedRows[0];

    expect(projectedRows).toHaveLength(originalRows.length);
    expect(projectedBytes).toBeLessThan(originalBytes * 0.4);
    expect(first?.kind).toBe("tool");
    if (first?.kind !== "tool") throw new Error("Expected tool row");
    expect(
      resolveTranscriptBodyArtifact(
        first.sessionId,
        first.outputArtifactId!,
        originalRows,
      )?.text,
    ).toBe(originalRows[0]?.output);
  });
});
