import { describe, expect, it } from "vitest";
import type { AgentControlPreferences } from "../backend/types";
import { mergeInitialPreferences, settingsErrorMessage } from "./settings";

const fallback: AgentControlPreferences = {
  workspace: "/fallback",
  workspaceLabel: "개인 Workspace",
  modelPreset: "codex-medium",
  permissionHandling: "prompt",
  gjcExecutable: "",
  thoughtsExpanded: false,
};

const loaded: AgentControlPreferences = {
  ...fallback,
  workspace: "/loaded",
  modelPreset: "codex-pro",
};

describe("settings preference loading", () => {
  it("keeps edits made while the initial preference read is pending", () => {
    const edited = { ...fallback, modelPreset: "custom-profile" };

    expect(mergeInitialPreferences(edited, loaded, true)).toEqual({
      preferences: edited,
      original: loaded,
    });
  });

  it("uses the loaded preferences when no edit preceded the response", () => {
    expect(mergeInitialPreferences(fallback, loaded, false)).toEqual({
      preferences: loaded,
      original: loaded,
    });
  });
});

describe("settings errors", () => {
  it("preserves useful Error messages and renders non-Error rejections", () => {
    expect(settingsErrorMessage(new Error("disk unavailable"))).toBe(
      "disk unavailable",
    );
    expect(settingsErrorMessage("IPC rejected")).toBe("IPC rejected");
  });
});
