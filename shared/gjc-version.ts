/**
 * The oldest GJC runtime this app is built against.
 *
 * The SDK session surface, confirmed operator Stop, and lifecycle diagnostics this
 * app relies on are all present from 0.18.12; older runtimes fail in ways that look
 * like app bugs, so the version is checked when the connection starts.
 */
export const GJC_MINIMUM_VERSION = "0.18.12";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

function parseGjcVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u.exec(value.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

/**
 * Orders two GJC versions.
 *
 * Numeric fields compare numerically, a release outranks its prereleases, and
 * prerelease identifiers compare lexically (only the ordering between two
 * prereleases of the same release matters for the minimum check).
 */
export function compareGjcVersions(left: string, right: string): number {
  const a = parseGjcVersion(left);
  const b = parseGjcVersion(right);
  if (!a || !b) return 0;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const partsA = a.prerelease.split(".");
  const partsB = b.prerelease.split(".");
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const one = partsA[index];
    const other = partsB[index];
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    if (one === other) continue;
    const oneNumeric = /^\d+$/u.test(one);
    const otherNumeric = /^\d+$/u.test(other);
    if (oneNumeric && otherNumeric) return Number(one) < Number(other) ? -1 : 1;
    if (oneNumeric !== otherNumeric) return oneNumeric ? -1 : 1;
    return one < other ? -1 : 1;
  }
  return 0;
}

/**
 * Whether the installed runtime meets the minimum.
 *
 * An absent or unparseable version is not evidence of an old runtime, so it does
 * not warn; the connection's own errors already cover a runtime that cannot answer.
 */
export function gjcVersionSupported(version: string | undefined): boolean {
  if (!version || !parseGjcVersion(version)) return true;
  return compareGjcVersions(version, GJC_MINIMUM_VERSION) >= 0;
}

/** The update guidance to show for an old runtime, or undefined when none is due. */
export function gjcVersionWarning(version: string | undefined): string | undefined {
  if (!version || gjcVersionSupported(version)) return undefined;
  return `GJC ${version} is older than the required ${GJC_MINIMUM_VERSION}. Update with \`bun add -g gajae-code@latest\` and reconnect.`;
}
