export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "gajae:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light" || value === "system";
}

/** The stored preference, without resolving `system` against the OS. */
export function readStoredTheme(
  storage: Pick<Storage, "getItem"> | null | undefined =
    typeof window === "undefined" ? null : window.localStorage,
): ThemeMode {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    return isThemeMode(stored) ? stored : "dark";
  } catch {
    return "dark";
  }
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(DARK_QUERY).matches
  );
}

let stopSystemListener: (() => void) | undefined;

/**
 * Applies a mode to the document and, for `system`, keeps following the OS.
 *
 * The resolved theme is written to `data-theme` instead of the mode itself so the
 * CSS never needs a `system` branch. A previous system listener is removed first:
 * editing the setting repeatedly must not stack subscriptions.
 */
export function applyThemeMode(
  mode: ThemeMode,
  root: HTMLElement | null =
    typeof document === "undefined" ? null : document.documentElement,
): ResolvedTheme {
  stopSystemListener?.();
  stopSystemListener = undefined;

  const paint = (): ResolvedTheme => {
    const resolved = resolveTheme(mode, systemPrefersDark());
    if (root) {
      root.dataset.theme = resolved;
      root.style.colorScheme = resolved;
    }
    return resolved;
  };

  const resolved = paint();
  if (mode !== "system" || typeof window === "undefined" || typeof window.matchMedia !== "function")
    return resolved;

  const media = window.matchMedia(DARK_QUERY);
  const onChange = (): void => {
    paint();
  };
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onChange);
    stopSystemListener = () => media.removeEventListener("change", onChange);
  } else {
    media.addListener(onChange);
    stopSystemListener = () => media.removeListener(onChange);
  }
  return resolved;
}

export function storeTheme(
  mode: ThemeMode,
  storage: Pick<Storage, "setItem"> | null | undefined =
    typeof window === "undefined" ? null : window.localStorage,
): void {
  try {
    storage?.setItem(STORAGE_KEY, mode);
  } catch {
    // A disabled storage is not a reason to make the selector unusable.
  }
}

/** Persists and applies one choice; the settings dialog uses this directly. */
export function setThemeMode(mode: ThemeMode): ResolvedTheme {
  storeTheme(mode);
  return applyThemeMode(mode);
}

/** Must run before the first React render so a light window never flashes dark. */
export function initializeTheme(): void {
  applyThemeMode(readStoredTheme());
}
