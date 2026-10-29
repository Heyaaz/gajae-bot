import { GJC_MINIMUM_VERSION } from "./gjc-version.js";

/** README's floor for the interpreter GJC's launcher runs on. */
export const BUN_MINIMUM_VERSION = "1.4.0";

export type EnvironmentCheckId =
  | "bun"
  | "gjc"
  | "model-preset"
  | "gh"
  | "tailscale";

/** Why a check is not ok. The renderer words it; the host only names it. */
export type EnvironmentProblem =
  | "not-found"
  | "too-old"
  | "unreadable"
  | "unknown-preset"
  | "signed-out"
  | "not-running";

export const ENVIRONMENT_MINIMUM_VERSIONS: Partial<
  Record<EnvironmentCheckId, string>
> = { bun: BUN_MINIMUM_VERSION, gjc: GJC_MINIMUM_VERSION };

/**
 * One row of the environment check.
 *
 * `detail` holds only facts that read the same in any language (a version, a
 * path, a profile ID). `missing` is reserved for a required tool that is absent;
 * an optional tool that is absent is a `warning`, never a failure.
 */
export type EnvironmentCheckRow = {
  id: EnvironmentCheckId;
  required: boolean;
  detail?: string;
} & (
  | { status: "ok" }
  | {
      status: "missing" | "warning";
      problem: EnvironmentProblem;
      /** The exact command that fixes it. The app never runs it. */
      fix: string;
    }
);

export interface EnvironmentReport {
  rows: EnvironmentCheckRow[];
  /** Every required row is ok. */
  ready: boolean;
  checkedAtMs: number;
}

export function environmentReady(
  rows: readonly EnvironmentCheckRow[],
): boolean {
  return rows.every((row) => !row.required || row.status === "ok");
}
