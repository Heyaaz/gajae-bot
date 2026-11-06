import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokensCss = readFileSync("src/index.css", "utf8");
const appCss = readFileSync("src/App.css", "utf8");

type Rgb = [number, number, number];

function themeTokens(theme: "dark" | "light"): Map<string, string> {
  const selector =
    theme === "dark" ? /:root,\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/u : /:root\[data-theme="light"\]\s*\{([^}]*)\}/u;
  const block = selector.exec(tokensCss)?.[1] ?? "";
  return new Map([...block.matchAll(/--([\w-]+):\s*([^;]+);/gu)].map((m) => [m[1]!, m[2]!.trim()]));
}

function rgb(value: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/iu.exec(value)?.[1];
  if (!hex) throw new Error(`not a hex color: ${value}`);
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function mix(front: Rgb, percent: number, back: Rgb): Rgb {
  return front.map((v, i) => Math.round((v * percent) / 100 + back[i]! * (1 - percent / 100))) as Rgb;
}

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(appCss)?.[1] ?? "";
}

function resolve(tokens: Map<string, string>, body: string, property: "color" | "background"): Rgb {
  const declaration = new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`, "u").exec(body)?.[1]?.trim();
  if (!declaration) throw new Error(`no ${property} on the rule`);
  const mixed = /color-mix\(in srgb,\s*var\(--([\w-]+)\)\s+(\d+)%,\s*var\(--([\w-]+)\)\)/u.exec(declaration);
  const token = (name: string): Rgb => rgb(tokens.get(name) ?? "");
  if (mixed) return mix(token(mixed[1]!), Number(mixed[2]), token(mixed[3]!));
  const plain = /^var\(--([\w-]+)\)$/u.exec(declaration);
  if (!plain) throw new Error(`unsupported ${property}: ${declaration}`);
  return token(plain[1]!);
}

describe("sidebar empty-state button (지난 세션 보기)", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`reaches WCAG AA 4.5:1 in the ${theme} theme, resting and hovered`, () => {
      const tokens = themeTokens(theme);
      const resting = rule(".sidebar-empty button");
      const hovered = rule(".sidebar-empty button:hover");
      const text = resolve(tokens, resting, "color");
      const restingRatio = contrast(text, resolve(tokens, resting, "background"));
      const hoverRatio = contrast(text, resolve(tokens, hovered, "background"));
      expect(restingRatio).toBeGreaterThanOrEqual(4.5);
      expect(hoverRatio).toBeGreaterThanOrEqual(4.5);
    });
  }
});
