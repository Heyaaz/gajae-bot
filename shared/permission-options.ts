import type { PermissionOption } from "./agent-contract.js";

/**
 * Korean labels for GJC's approval choices, keyed by kind. GJC names the choices
 * in English ("Allow once"), so the name is shown only for a kind this table
 * does not know.
 */
export const PERMISSION_OPTION_LABELS: Readonly<Record<string, string>> = {
  allow_once: "이번만 허용",
  allow_always: "항상 허용",
  reject_once: "거절",
  reject_always: "항상 거절",
};

export function permissionOptionLabel(option: Pick<PermissionOption, "kind" | "name">): string {
  return PERMISSION_OPTION_LABELS[option.kind] ?? option.name;
}
