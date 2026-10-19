import type { LinkPreview } from "../../shared/productivity-ipc";
import { Check, ChevronDown, Copy, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { parseDiffFiles, parseDiffLines } from "./format";
import { t } from "../i18n";


export interface SelectOption<T extends string> {
  value: T;
  label: string;
  shortLabel?: string;
  description?: string;
}

export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  icon,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  icon?: ReactNode;
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
        {icon}
        <span>{selected?.shortLabel ?? selected?.label ?? value}</span>
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
              <span className={option.description ? "dropdown-option-copy" : undefined}>
                {option.label}
                {option.description && <small>{option.description}</small>}
              </span>
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
      title={copied ? t("복사됨") : t("복사")}
      onClick={() => void copy()}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

/** Only `header`/`hunk` rows carry no line number; everything else does. */
function diffLineNumberLabel(line: {
  oldLineNumber?: number;
  newLineNumber?: number;
}): string {
  const oldText = line.oldLineNumber !== undefined ? String(line.oldLineNumber) : "";
  const newText = line.newLineNumber !== undefined ? String(line.newLineNumber) : "";
  return `${oldText}\u2009${newText}`;
}

function DiffFileBlock({
  path,
  lines,
  defaultOpen,
}: {
  path?: string;
  lines: ReturnType<typeof parseDiffLines>;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
          {lines
            .filter((line) => line.kind !== "header")
            .map((line, index) => (
              <span key={index} className={`diff-line diff-line--${line.kind}`}>
                <span className="diff-line-numbers">
                  {line.kind === "hunk" ? "" : diffLineNumberLabel(line)}
                </span>
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

export function DiffView({ diff, path }: { diff: string; path?: string }) {
  const files = parseDiffFiles(diff);
  // Single-file diffs (the common case: one edit/write tool call) default open,
  // the way the collapsed-but-single summary always behaved. Multiple files
  // default collapsed so a multi-file diff does not take over the screen.
  const singleFile = files.length <= 1;
  return (
    <>
      {files.map((file, index) => (
        <DiffFileBlock
          key={file.path ?? index}
          path={file.path ?? path}
          lines={file.lines}
          defaultOpen={singleFile}
        />
      ))}
    </>
  );
}
