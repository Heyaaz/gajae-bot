import { describe, expect, it } from "vitest";
import {
  applyThemeMode,
  isThemeMode,
  readStoredTheme,
  resolveTheme,
  storeTheme,
} from "./theme";

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set("gajae:theme", initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("theme preference", () => {
  it("recognizes only the three supported modes", () => {
    expect(isThemeMode("light")).toBe(true);
    expect(isThemeMode("dark")).toBe(true);
    expect(isThemeMode("system")).toBe(true);
    expect(isThemeMode("solarized")).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });

  it("defaults to dark and ignores junk in storage", () => {
    expect(readStoredTheme(storage())).toBe("dark");
    expect(readStoredTheme(storage("light"))).toBe("light");
    expect(readStoredTheme(storage("system"))).toBe("system");
    expect(readStoredTheme(storage("sepia"))).toBe("dark");
  });

  it("resolves system against the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("stores a choice and applies the resolved theme to the root", () => {
    const values = storage();
    storeTheme("light", values);
    expect(values.getItem("gajae:theme")).toBe("light");

    const root = {
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>,
    };
    expect(applyThemeMode("light", root as unknown as HTMLElement)).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });
});
