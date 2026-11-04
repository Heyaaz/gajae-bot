import type { ResolvedTheme } from "../theme";

type MermaidApi = typeof import("mermaid").default;

const CACHE_LIMIT = 40;

let mermaidModule: Promise<MermaidApi> | undefined;
// mermaid keeps one global config and renders against it, so concurrent renders with
// different themes would draw each other's colors. One chain keeps them in order.
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;
const cache = new Map<string, string>();

function loadMermaid(): Promise<MermaidApi> {
  mermaidModule ??= import("mermaid").then((mod) => mod.default);
  return mermaidModule;
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

/** Colors come from the app's own tokens so a diagram reads as part of the page. */
function themeVariables(theme: ResolvedTheme): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const dark = theme === "dark";
  const text = token(style, "--text-primary", dark ? "#f1f1f3" : "#17171a");
  const muted = token(style, "--text-secondary", dark ? "#a6a6ad" : "#56565f");
  const faint = token(style, "--text-tertiary", muted);
  const card = token(style, "--bg-card", dark ? "#212124" : "#f7f7f9");
  const raised = token(style, "--bg-raised", dark ? "#1b1b1e" : "#f3f3f5");
  return {
    darkMode: String(dark),
    background: "transparent",
    dropShadow: "none",
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontSize: "14px",
    primaryColor: card,
    primaryTextColor: text,
    primaryBorderColor: faint,
    secondaryColor: raised,
    tertiaryColor: raised,
    lineColor: muted,
    textColor: text,
    mainBkg: card,
    nodeBorder: faint,
    clusterBkg: raised,
    clusterBorder: faint,
    edgeLabelBackground: token(style, "--bg-code", raised),
    titleColor: text,
  };
}

function cacheKey(theme: ResolvedTheme, source: string): string {
  return `${theme}\u0000${source}`;
}

/** An already-drawn diagram, so a remounted row shows it without a flash of source. */
export function cachedDiagram(theme: ResolvedTheme, source: string): string | undefined {
  return cache.get(cacheKey(theme, source));
}

/**
 * Draws one Mermaid source to an SVG string.
 *
 * `securityLevel: "strict"` makes mermaid sanitize labels and refuse click handlers,
 * and nothing here configures an external resource. Rejects on a parse error; the
 * caller keeps the source on screen.
 */
export function renderDiagram(theme: ResolvedTheme, source: string): Promise<string> {
  const key = cacheKey(theme, source);
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const run = async (): Promise<string> => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: themeVariables(theme),
    });
    const id = `gajae-mermaid-${nextId++}`;
    try {
      const { svg } = await mermaid.render(id, source);
      cache.set(key, svg);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
      return svg;
    } finally {
      document.getElementById(`d${id}`)?.remove();
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
