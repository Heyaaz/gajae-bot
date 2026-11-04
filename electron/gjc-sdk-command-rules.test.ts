import { describe, expect, it, vi } from "vitest";
import type { ToolActivity } from "../shared/agent-contract.js";
import { GjcSdkController } from "./gjc-sdk-controller.js";
import type { PendingPermission, PermissionResponse } from "./gjc-sdk-model.js";
import { requestPermission } from "./gjc-sdk-stream.js";

const OPTIONS: PendingPermission["request"]["options"] = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

function setup(session: Record<string, unknown> = {}) {
  const commandRules = {
    decide: vi.fn(async () => undefined as { decision: "allow" | "reject"; prefix: string } | undefined),
    add: vi.fn(async () => undefined),
  };
  const controller = new GjcSdkController({ workspace: "/repo", emit: vi.fn(), commandRules } as never);
  const internals = controller as any;
  internals.persistArtifact = vi.fn(async () => undefined);
  internals.sessions.set("s1", { id: "s1", workspace: "/repo", status: "running", ...session });

  const ask = (toolCall: Partial<PendingPermission["request"]["toolCall"]> = {}) => {
    const request: PendingPermission["request"] = {
      sessionId: "s1",
      toolCall: { toolCallId: "call-1", toolName: "bash", command: "git status", ...toolCall },
      options: OPTIONS,
    };
    const settled: PermissionResponse[] = [];
    void requestPermission(internals.host, request).then((response) => settled.push(response));
    return settled;
  };
  const tool = () =>
    (internals.transcripts.get("s1") as ToolActivity[] | undefined)?.find((item) => item.id === "call-1");
  const channelHost = () => (internals.permissionChannels as any).host;
  return { controller, commandRules, internals, ask, tool, channelHost };
}

describe("remembering a rule with a tool decision", () => {
  it("saves an allow rule for the session's project before answering", async () => {
    const { controller, commandRules, ask, tool } = setup();
    const settled = ask();
    await controller.resolveToolCall("call-1", { optionId: "allow_once", rule: { prefix: "git status" } });
    expect(commandRules.add).toHaveBeenCalledWith("/repo", "git status", "allow");
    expect(settled).toEqual([{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
    expect(tool()?.status).toBe("approved");
  });

  it("saves a reject rule from a rejection and keeps its comment", async () => {
    const { controller, commandRules, ask, tool } = setup();
    const settled = ask({ command: "git push origin main" });
    await controller.resolveToolCall("call-1", {
      optionId: "reject_once",
      comment: "no pushing",
      rule: { prefix: "git push" },
    });
    expect(commandRules.add).toHaveBeenCalledWith("/repo", "git push", "reject");
    expect(settled).toEqual([{ outcome: { outcome: "selected", optionId: "reject_once" }, comment: "no pushing" }]);
    expect(tool()?.status).toBe("denied");
  });

  it("files the rule under the source project of a managed worktree session", async () => {
    const { controller, commandRules, ask } = setup({
      workspace: "/repo/.claude/worktrees/a",
      worktree: { managed: true, sourceWorkspace: "/repo", path: "/repo/.claude/worktrees/a", branch: "a" },
    });
    ask();
    await controller.resolveToolCall("call-1", { optionId: "allow_once", rule: { prefix: "git status" } });
    expect(commandRules.add).toHaveBeenCalledWith("/repo", "git status", "allow");
  });

  it("saves nothing for a decision without a rule", async () => {
    const { controller, commandRules, ask } = setup();
    ask();
    await controller.resolveToolCall("call-1", { optionId: "allow_once" });
    expect(commandRules.add).not.toHaveBeenCalled();
  });

  it("answers the request even when the rule cannot be saved, then reports the failure", async () => {
    const { controller, commandRules, ask, tool } = setup();
    commandRules.add.mockRejectedValueOnce(new Error("disk full"));
    const settled = ask();
    await expect(
      controller.resolveToolCall("call-1", { optionId: "allow_once", rule: { prefix: "git status" } }),
    ).rejects.toThrow("disk full");
    expect(settled).toEqual([{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
    expect(tool()?.status).toBe("approved");
  });

  it("answers the request but refuses a rule on a call that is not bash", async () => {
    const { controller, commandRules, ask } = setup();
    const settled = ask({ toolName: "write", command: undefined });
    await expect(
      controller.resolveToolCall("call-1", { optionId: "allow_once", rule: { prefix: "write" } }),
    ).rejects.toThrow(/bash/);
    expect(commandRules.add).not.toHaveBeenCalled();
    expect(settled).toHaveLength(1);
  });

  it("describes the standing rule in the confirmation an allow needs", () => {
    const { controller, ask } = setup();
    ask();
    const info = controller.toolDecisionInfo("call-1", { optionId: "allow_once", rule: { prefix: "git status" } });
    expect(info.requiresConfirmation).toBe(true);
    expect(info.name).toContain("이번만 허용");
    expect(info.name).toContain('"git status"');
    expect(controller.toolDecisionInfo("call-1", { optionId: "allow_once" }).name).toBe("이번만 허용");
  });
});

describe("deciding a request from the project rules", () => {
  it("asks the rules about a bash command in the session's project", async () => {
    const { commandRules, channelHost } = setup();
    commandRules.decide.mockResolvedValueOnce({ decision: "allow", prefix: "git status" });
    const match = await channelHost().autoDecide("s1", { toolCallId: "call-1", toolName: "bash", command: "git status" });
    expect(match).toEqual({ decision: "allow", prefix: "git status" });
    expect(commandRules.decide).toHaveBeenCalledWith("/repo", "bash", "git status");
  });

  it("does not consult the rules for another tool or a call with no command", async () => {
    const { commandRules, channelHost } = setup();
    expect(await channelHost().autoDecide("s1", { toolCallId: "c", toolName: "write" })).toBeUndefined();
    expect(await channelHost().autoDecide("s1", { toolCallId: "c", toolName: "bash" })).toBeUndefined();
    expect(commandRules.decide).not.toHaveBeenCalled();
  });

  it("notes the decision on a tool row that is still waiting", () => {
    const { channelHost, ask, tool } = setup();
    ask();
    channelHost().noteAutoDecision("s1", { toolCallId: "call-1", toolName: "bash", command: "git status" }, {
      decision: "allow",
      prefix: "git status",
    });
    expect(tool()).toMatchObject({ status: "approved", autoDecision: { decision: "allow", prefix: "git status" } });
  });

  it("creates the row for a call the stream has not shown yet", () => {
    const { channelHost, tool } = setup();
    channelHost().noteAutoDecision(
      "s1",
      { toolCallId: "call-1", toolName: "bash", title: "git push", command: "git push" },
      { decision: "reject", prefix: "git push" },
    );
    expect(tool()).toMatchObject({
      name: "bash",
      description: "git push",
      status: "denied",
      autoDecision: { decision: "reject", prefix: "git push" },
    });
    expect(JSON.parse(tool()!.command!)).toEqual({ command: "git push" });
  });

  it("keeps the status of a call that already ran when the note arrives late", () => {
    const { channelHost, internals, tool } = setup();
    internals.upsertTool("s1", {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      status: "completed",
      rawInput: { command: "git status" },
    });
    channelHost().noteAutoDecision("s1", { toolCallId: "call-1", toolName: "bash", command: "git status" }, {
      decision: "allow",
      prefix: "git status",
    });
    expect(tool()).toMatchObject({ status: "completed", autoDecision: { decision: "allow", prefix: "git status" } });
  });
});
