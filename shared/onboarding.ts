/** How the user proves who they are to a provider during GJC's own login. */
export type SignInMethod = "browser" | "api-key";

export interface SignInProvider {
  /** GJC's login provider ID (`gjc auth-broker login <id>`). */
  id: string;
  /** A product name, the same in any language. */
  name: string;
  method: SignInMethod;
  /** GJC's recommended model profile for this provider (its PROFILE_RECOMMENDATIONS). */
  preset: string;
}

/**
 * The providers first-run setup offers: each one GJC can log in to by itself and
 * has a built-in model profile for, so signing in is all a new user does.
 */
export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = [
  { id: "openai-codex", name: "ChatGPT Plus/Pro", method: "browser", preset: "codex-medium" },
  { id: "anthropic", name: "Claude Pro/Max", method: "browser", preset: "claude-opus" },
  { id: "cursor", name: "Cursor", method: "browser", preset: "cursor-medium" },
  { id: "xai", name: "Grok (xAI)", method: "browser", preset: "grok-46-medium" },
  { id: "kimi-code", name: "Kimi Code", method: "browser", preset: "kimi-coding-plan-medium" },
  { id: "zai", name: "Z.AI GLM Coding Plan", method: "api-key", preset: "glm-medium" },
  { id: "minimax-code", name: "MiniMax Coding Plan", method: "api-key", preset: "minimax-medium" },
  { id: "opencode-go", name: "OpenCode Go", method: "api-key", preset: "opencodego" },
];

/** What first-run setup still has to do, or null when nothing is left. */
export type OnboardingStep = "install" | "sign-in";

export type OnboardingEvent =
  | { type: "install-progress"; receivedBytes: number; totalBytes?: number }
  | { type: "open-url"; url: string; instructions?: string }
  | { type: "prompt"; message: string };

export const ONBOARDING_IPC = {
  pendingStep: "agent-control:onboarding:pending-step",
  installGjc: "agent-control:onboarding:install-gjc",
  signIn: "agent-control:onboarding:sign-in",
  answer: "agent-control:onboarding:answer",
  cancelSignIn: "agent-control:onboarding:cancel-sign-in",
  dismiss: "agent-control:onboarding:dismiss",
  event: "agent-control:onboarding:event",
} as const;

export interface OnboardingDesktopBridge {
  pendingStep(): Promise<OnboardingStep | null>;
  /** Resolves with the installed version once the runtime has reconnected to it. */
  installGjc(): Promise<{ version: string }>;
  /** Resolves once GJC saved the credential and the app switched to its model profile. */
  signIn(providerId: string): Promise<void>;
  answer(text: string): Promise<void>;
  cancelSignIn(): Promise<void>;
  /** The user chose to set GJC up on their own; first-run setup does not open again. */
  dismiss(): Promise<void>;
  onEvent(listener: (event: OnboardingEvent) => void): () => void;
}
