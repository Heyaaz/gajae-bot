import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../../shared/agent-contract";
import type { AgentControlPreferences } from "../backend/types";
import {
  canSavePreferences,
  mergeInitialPreferences,
  resolvePreferenceSave,
  settingsErrorMessage,
} from "./settings";

const fallback: AgentControlPreferences = {
  workspace: "/fallback",
  workspaceLabel: "개인 Workspace",
  modelPreset: "codex-medium",
  permissionHandling: "prompt",
  gjcExecutable: "",
  thoughtsExpanded: false,
  toolViewMode: "reasoning",
  notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
  runningSubmission: "queue",
};

const loaded: AgentControlPreferences = {
  ...fallback,
  workspace: "/loaded",
  modelPreset: "codex-pro",
  gjcExecutable: "/opt/gjc",
  permissionHandling: "always-allow",
};

describe("settings preference loading", () => {
  it("keeps only the fields edited while the initial read was pending", () => {
    const edited = { ...fallback, modelPreset: "custom-profile" };

    expect(mergeInitialPreferences(edited, loaded, ["modelPreset"])).toEqual({
      // The stored workspace, executable and permission mode survive an edit to
      // an unrelated field instead of being replaced by the fallback draft.
      preferences: { ...loaded, modelPreset: "custom-profile" },
      original: loaded,
    });
  });

  it("merges several edited fields over the loaded preferences", () => {
    const edited = {
      ...fallback,
      workspace: "/picked",
      thoughtsExpanded: true,
    };
    expect(
      mergeInitialPreferences(edited, loaded, ["workspace", "thoughtsExpanded"]),
    ).toEqual({
      preferences: {
        ...loaded,
        workspace: "/picked",
        thoughtsExpanded: true,
      },
      original: loaded,
    });
  });

  it("uses the loaded preferences when no edit preceded the response", () => {
    expect(mergeInitialPreferences(fallback, loaded, [])).toEqual({
      preferences: loaded,
      original: loaded,
    });
  });
});

describe("settings save gate", () => {
  it("does not save before the initial read succeeds", () => {
    // A failed or pending read leaves the draft on fallback values; saving it
    // would overwrite every stored setting the user did not touch.
    expect(canSavePreferences(true, false, true, false)).toBe(false);
    expect(canSavePreferences(true, false, true, true)).toBe(true);
  });

  it("still requires a change, an idle save, and a bridge", () => {
    expect(canSavePreferences(false, false, true, true)).toBe(false);
    expect(canSavePreferences(true, true, true, true)).toBe(false);
    expect(canSavePreferences(true, false, false, true)).toBe(false);
  });
});

describe("settings save completion", () => {
  const saved: AgentControlPreferences = {
    ...loaded,
    modelPreset: "saved-profile",
    gjcExecutable: "",
  };
  const newer: AgentControlPreferences = {
    ...loaded,
    modelPreset: "edited-while-saving",
  };

  it("adopts the saved values and closes only for the same draft", () => {
    expect(
      resolvePreferenceSave({
        mounted: true,
        revisionAtSave: 3,
        revisionNow: 3,
        current: loaded,
        saved,
      }),
    ).toEqual({
      notify: true,
      close: true,
      preferences: saved,
      original: saved,
    });
  });

  it("keeps an edit made while the save was pending and stays open", () => {
    expect(
      resolvePreferenceSave({
        mounted: true,
        revisionAtSave: 3,
        revisionNow: 4,
        current: newer,
        saved,
      }),
    ).toEqual({
      notify: true,
      close: false,
      preferences: newer,
      original: saved,
    });
  });

  it("lets no response from an unmounted dialog touch the active one", () => {
    expect(
      resolvePreferenceSave({
        mounted: false,
        revisionAtSave: 7,
        revisionNow: 7,
        current: newer,
        saved,
      }),
    ).toEqual({
      notify: false,
      close: false,
      preferences: newer,
      original: newer,
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
