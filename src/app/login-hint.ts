import { createContext } from "react";

/**
 * Whether GJC has no signed-in AI provider, and how to fix that. Provided by the
 * shell so a failed turn deep in the transcript can name the cause and offer the
 * sign-in without every layer between them carrying it.
 */
export interface LoginHint {
  needsSignIn: boolean;
  openLogin?: () => void;
}

export const LoginHintContext = createContext<LoginHint>({ needsSignIn: false });
