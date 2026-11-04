import { Code2, Workflow } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { t } from "../i18n";
import type { ResolvedTheme } from "../theme";
import { CodeCopyButton } from "./code-copy-button";
import { cachedDiagram, renderDiagram } from "./mermaid-render";

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function currentTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Mermaid sizes its SVG to the container (`width="100%"` and a `max-width`), which
 * shrinks a wide diagram until its labels are unreadable. The drawn width goes to
 * CSS, which shrinks a diagram only down to a readable scale and leaves the rest to
 * the scroll container.
 */
function Diagram({ svg }: { svg: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current?.querySelector("svg");
    const width = Number(element?.getAttribute("viewBox")?.split(/[\s,]+/u)[2]);
    if (element && Number.isFinite(width) && width > 0) {
      element.style.setProperty("--mermaid-width", `${width}px`);
    }
  }, [svg]);
  return (
    <div
      ref={host}
      className="mermaid-diagram"
      role="img"
      aria-label={t("Mermaid 다이어그램")}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

type Drawing =
  | { status: "pending" }
  | { status: "ready"; svg: string }
  | { status: "failed" };

function useDiagram(source: string, theme: ResolvedTheme): Drawing {
  const [drawn, setDrawn] = useState<{ key: string; drawing: Drawing }>();
  const key = `${theme}\u0000${source}`;
  const cached = cachedDiagram(theme, source);
  useEffect(() => {
    if (cached !== undefined) return;
    let current = true;
    renderDiagram(theme, source).then(
      (svg) => current && setDrawn({ key, drawing: { status: "ready", svg } }),
      () => current && setDrawn({ key, drawing: { status: "failed" } }),
    );
    return () => {
      current = false;
    };
  }, [cached, key, source, theme]);
  if (cached !== undefined) return { status: "ready", svg: cached };
  return drawn?.key === key ? drawn.drawing : { status: "pending" };
}

/**
 * A complete ```mermaid fence drawn as an SVG diagram.
 *
 * Until the diagram is ready, and for good if mermaid rejects the source, the
 * ordinary code block stays on screen so the message never loses its content.
 * `source` is the fence's text and `fallback` the code block already rendered for
 * it; `sourcePre` is that block's bare `<pre>`, shown by the source toggle.
 */
export function MermaidBlock({
  source,
  fallback,
  sourcePre,
}: {
  source: string;
  fallback: ReactNode;
  sourcePre: ReactNode;
}) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => "dark" as const);
  const drawing = useDiagram(source, theme);
  const [showSource, setShowSource] = useState(false);
  if (drawing.status === "pending") return fallback;
  if (drawing.status === "failed")
    return (
      <>
        {fallback}
        <p className="mermaid-note" role="status">
          {t("다이어그램을 그리지 못했습니다")}
        </p>
      </>
    );
  const toggleLabel = showSource ? t("다이어그램 보기") : t("원본 보기");
  return (
    <div className="code-block mermaid-block">
      <header>
        <span className="code-block-lang">mermaid</span>
        <span className="code-block-actions">
          <button
            type="button"
            className="code-block-copy"
            title={toggleLabel}
            aria-label={toggleLabel}
            aria-pressed={showSource}
            onClick={() => setShowSource((value) => !value)}
          >
            {showSource ? <Workflow size={12} /> : <Code2 size={12} />}
          </button>
          <CodeCopyButton text={source} />
        </span>
      </header>
      {showSource ? (
        sourcePre
      ) : (
        <div className="mermaid-scroll">
          <Diagram svg={drawing.svg} />
        </div>
      )}
    </div>
  );
}
