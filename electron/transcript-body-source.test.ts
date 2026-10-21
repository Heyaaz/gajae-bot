import { describe, expect, it } from "vitest";
import type { ToolActivity } from "../shared/agent-contract.js";
import { MAX_TOOL_TEXT } from "./gjc-sdk-model.js";
import { boundedJson, fullToolText } from "./gjc-sdk-commands.js";
import { sharedTranscriptItems, toolResultText } from "./gjc-sdk-transcript.js";

function toolFrom(rows: unknown[]): ToolActivity {
  const tool = sharedTranscriptItems("s1", rows).find(
    (item) => item.kind === "tool",
  );
  if (!tool || tool.kind !== "tool") throw new Error("tool row was not built");
  return tool;
}

describe("full tool transcript sources", () => {
  it("retains the final sentinel in a tool body longer than the old bound", () => {
    const body = `${"x".repeat(MAX_TOOL_TEXT + 1)}body-final-sentinel`;
    const tool = toolFrom([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "t1", body },
    ]);

    expect(tool.output).toBe(body);
    expect(tool.output).toContain("body-final-sentinel");
  });

  it("retains the full text content when a tool result has no body", () => {
    const content = `${"x".repeat(MAX_TOOL_TEXT + 1)}content-final-sentinel`;

    expect(
      toolResultText({ body: "", content: [{ type: "text", text: content }] }),
    ).toBe(content);
  });

  it("keeps structured tool input in full while redacting credentials", () => {
    const input = {
      payload: `${"x".repeat(MAX_TOOL_TEXT + 1)}input-final-sentinel`,
      apiKey: "sk-abcdefghijklmnopqrst",
    };
    const tool = toolFrom([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "write", arguments: input }],
      },
    ]);

    expect(tool.command).toContain('"payload":');
    expect(tool.command).toContain("input-final-sentinel");
    expect(tool.command).toContain('"apiKey": "[REDACTED]"');
    expect(tool.command).not.toContain("sk-abcdefghijklmnopqrst");
  });

  it("keeps full structured details in the existing output format", () => {
    const details = {
      records: [`${"x".repeat(MAX_TOOL_TEXT + 1)}details-final-sentinel`],
      apiKey: "sk-abcdefghijklmnopqrst",
    };
    const tool = toolFrom([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "inspect", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        body: "plain tool result",
        details,
      },
    ]);

    expect(tool.output).toContain("plain tool result\n\ndetails\n{\n");
    expect(tool.output).toContain('"records": [');
    expect(tool.output).toContain("details-final-sentinel");
    expect(tool.output).toContain('"apiKey": "[REDACTED]"');
    expect(tool.output).not.toContain("sk-abcdefghijklmnopqrst");
  });

  it("keeps boundedJson limited for unrelated callers", () => {
    const value = `${"x".repeat(MAX_TOOL_TEXT + 5)}non-tool-final-sentinel`;

    expect(boundedJson(value)).toBe(`${"x".repeat(MAX_TOOL_TEXT)}…`);
    expect(fullToolText(value)).toBe(value);
    expect(fullToolText(null)).toBeUndefined();
    expect(fullToolText(undefined)).toBeUndefined();
  });
});
