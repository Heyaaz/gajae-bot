import type {
  GjcDesktopBridge,
  SettingsDesktopBridge,
  ManagementDesktopBridge,
} from "../shared/agent-contract";
import type { RemoteDesktopBridge } from "../shared/remote-protocol";
import type { ProductivityDesktopBridge } from "../shared/productivity-ipc";
import type { AutomationDesktopBridge } from "../shared/automation-ipc";
import type { SessionShortcut } from "../shared/settings-ipc";

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
