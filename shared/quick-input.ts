import { projectPathOf, type AgentSession } from "./agent-contract.js";

/**
 * Channels of the quick input window.
 *
 * Only that window may call them: main guards them with a sender check of their
 * own, and the quick input window is not registered for any other channel.
 */
export const QUICK_INPUT_IPC = {
  state: "gajae:quick-input:state",
  capture: "gajae:quick-input:capture",
  submit: "gajae:quick-input:submit",
  dismiss: "gajae:quick-input:dismiss",
  openScreenRecordingSettings: "gajae:quick-input:open-screen-recording-settings",
  /** Pushed each time the window is shown, so it reloads the project list and takes focus. */
  shown: "gajae:quick-input:shown",
} as const;

/** Whether the global shortcut is live, for the desktop settings tab. */
export type QuickInputShortcutStatus =
  | { state: "off" }
  | { state: "registered"; accelerator: string }
  /**
   * `invalid`: Electron cannot parse the accelerator. `unavailable`: the system
   * refused it, which is what another app holding the same keys looks like.
   */
  | { state: "failed"; accelerator: string; reason: "invalid" | "unavailable" };

export interface QuickInputState {
  /** Project directories, most recently active first. */
  projects: string[];
}

/** A screenshot held by main until the window submits or forgets it. */
export interface QuickInputCapture {
  id: string;
  name: string;
  /** Base64 PNG, for the thumbnail. */
  data: string;
}

export type ScreenCaptureResult =
  | { outcome: "captured"; capture: QuickInputCapture }
  /** The user pressed Escape in the capture overlay. */
  | { outcome: "cancelled" }
  /** macOS Screen Recording is off for this app; capturing again would only repeat that. */
  | { outcome: "permission-denied" }
  | { outcome: "failed"; message: string };

export interface QuickInputSubmission {
  workspace: string;
  prompt: string;
  captureIds: string[];
}

export interface QuickInputDesktopBridge {
  state(): Promise<QuickInputState>;
  capture(): Promise<ScreenCaptureResult>;
  submit(submission: QuickInputSubmission): Promise<void>;
  dismiss(): Promise<void>;
  openScreenRecordingSettings(): Promise<void>;
  onShown(listener: () => void): () => void;
}

/**
 * The projects the quick input offers, most recently active first.
 *
 * Built in main from the session rows it already follows, so the window does not
 * need the runtime channels or an event stream of its own just to fill a picker.
 * The configured workspace closes the list so a first launch still has one choice.
 */
export function quickInputProjects(
  sessions: readonly Pick<AgentSession, "workspace" | "worktree" | "updatedAtMs">[],
  fallbackWorkspace: string,
): string[] {
  const ranked = [...sessions].sort(
    (left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0),
  );
  const projects = new Set(ranked.map(projectPathOf));
  if (fallbackWorkspace) projects.add(fallbackWorkspace);
  projects.delete("");
  return [...projects];
}

/** Checks a submission from the window before main acts on it. */
export function parseQuickInputSubmission(value: unknown): QuickInputSubmission {
  const candidate =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const { workspace, prompt, captureIds } = candidate;
  if (typeof workspace !== "string" || !workspace.startsWith("/"))
    throw new Error("Quick input workspace must be an absolute path");
  if (typeof prompt !== "string" || prompt.length > 100_000)
    throw new Error("Quick input prompt must be text");
  if (
    !Array.isArray(captureIds) ||
    captureIds.length > 6 ||
    captureIds.some((id) => typeof id !== "string")
  )
    throw new Error("Quick input captures are invalid");
  if (!prompt.trim() && captureIds.length === 0)
    throw new Error("Quick input is empty");
  return { workspace, prompt, captureIds: captureIds as string[] };
}
