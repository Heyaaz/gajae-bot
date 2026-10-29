import type {
  GjcDesktopBridge,
  SettingsDesktopBridge,
  ManagementDesktopBridge,
} from "../shared/agent-contract";
import type { RemoteDesktopBridge } from "../shared/remote-protocol";
import type { ProductivityDesktopBridge } from "../shared/productivity-ipc";
import type { AutomationDesktopBridge } from "../shared/automation-ipc";
import type { RepoDesktopBridge } from "../shared/repo-ipc";
import type { ParallelDesktopBridge } from "../shared/parallel-ipc";
import type { TerminalDesktopBridge } from "../shared/terminal-ipc";
import type { SessionShortcut } from "../shared/settings-ipc";
import type { QuickInputDesktopBridge } from "../shared/quick-input";
import type { OnboardingDesktopBridge } from "../shared/onboarding";

declare global {
  interface AgentControlDesktopBridge {
    readonly platform: NodeJS.Platform;
    readonly versions: {
      readonly chrome: string;
      readonly electron: string;
    };
    readonly gjc: GjcDesktopBridge;
    readonly settings: SettingsDesktopBridge;
    readonly management: ManagementDesktopBridge;
    readonly remote: RemoteDesktopBridge;
    readonly productivity: ProductivityDesktopBridge;
    readonly automations: AutomationDesktopBridge;
    readonly repo: RepoDesktopBridge;
    readonly parallel: ParallelDesktopBridge;
    readonly terminal: TerminalDesktopBridge;
    readonly quickInput: QuickInputDesktopBridge;
    /** Absent from an older main or a window without first-run setup. */
    readonly onboarding?: OnboardingDesktopBridge;
    onCycleEffort(listener: () => void): () => void;
    onAbortRun(listener: () => void): () => void;
    onSessionShortcut(
      listener: (shortcut: SessionShortcut) => void,
    ): () => void;
  }

  interface Window {
    readonly agentControlDesktop?: AgentControlDesktopBridge;
  }
}

export {};
