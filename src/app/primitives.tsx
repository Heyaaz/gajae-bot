import type { LinkPreview } from "../../shared/productivity-ipc";
import { Check, ChevronDown, Copy, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { parseDiffLines } from "./format";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function pick(next: T): void {
    onChange(next);
    setOpen(false);
  }

  return (
    <div className={`dropdown ${open ? "is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="dropdown-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="dropdown-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "is-selected" : ""}
              onClick={() => pick(option.value)}
            >
              <Check size={12} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function LinkPreviewCard({
  url,
  compact = false,
}: {
  url: string;
  compact?: boolean;
}) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);

  useEffect(() => {
    const bridge = window.agentControlDesktop?.productivity;
    if (!bridge) return;
    let active = true;
    const timer = window.setTimeout(
      () => {
        void bridge
          .previewLink(url)
          .then((value) => {
            if (active) setPreview(value);
          })
          .catch(() => undefined);
      },
      compact ? 350 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [compact, url]);

  if (!preview) return null;
  return (
    <a
      className={`link-preview ${compact ? "link-preview--compact" : ""}`}
      href={preview.url}
      target="_blank"
      rel="noreferrer"
    >
      <span>
        <strong>{preview.title}</strong>
        {preview.description && <small>{preview.description}</small>}
        <code>{preview.siteName || new URL(preview.url).hostname}</code>
      </span>
      <ExternalLink size={14} />
    </a>
  );
}

export function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }
  if (!text.trim()) return null;
  return (
    <button
      type="button"
      className={`message-copy ${copied ? "is-copied" : ""}`}
      title={copied ? "복사됨" : "복사"}
      onClick={() => void copy()}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

export function DiffView({ diff, path }: { diff: string; path?: string }) {
  const [open, setOpen] = useState(false);
  const lines = parseDiffLines(diff);
  const added = lines.filter((line) => line.kind === "added").length;
  const removed = lines.filter((line) => line.kind === "removed").length;
  const hunks = lines.filter((line) => line.kind === "hunk").length;
  return (
    <div className="tool-diff">
      <button
        className="tool-diff-summary"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown size={12} className={open ? "is-open" : ""} />
        {path && <span className="tool-diff-path">{path}</span>}
        <span className="tool-diff-added">+{added}</span>
        <span className="tool-diff-removed">-{removed}</span>
        <small>{hunks || 1} hunk</small>
      </button>
      {open && (
        <pre className="tool-diff-body">
          {lines.map((line, index) => (
            <span key={index} className={`diff-line diff-line--${line.kind}`}>
              <span className="diff-marker">
                {line.kind === "added"
                  ? "+"
                  : line.kind === "removed"
                    ? "-"
                    : " "}
              </span>
              {line.text}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
