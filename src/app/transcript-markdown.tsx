import ReactMarkdown from "react-markdown";
import { streamingMarkdownState } from "../transcript-utils";
import { MARKDOWN_REMARK_PLUGINS } from "./markdown-plugins";
import { Check, Copy } from "lucide-react";
import {
  isValidElement,
  memo,
  useRef,
  useState,
} from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { t } from "../i18n";

/**
 * A fenced code block's own text, read back out of its single text-node child.
 *
 * react-markdown hands the renderer React children (so inline formatting inside a
 * code span still works), not the raw string -- but a fenced block is never inline
 * formatted, so its child is reliably one string and copying it is exactly copying
 * what was fenced.
 */
function codeBlockText(children: ReactNode): string {
  if (typeof children === "string") return children.replace(/\n$/u, "");
  if (Array.isArray(children))
    return children.map((child) => codeBlockText(child)).join("");
  return "";
}

/**
 * Replaces ReactMarkdown's default `pre`/`code` pair for a fenced block with one
 * that names the fence's language and offers a one-click copy of the block's own
 * text -- distinct from the message-level copy button, which copies the whole
 * reply and loses which part was code.
 *
 * ReactMarkdown calls `pre` for every `pre` node, fenced or not (an indented code
 * block has no language and renders through the same path). Untagged blocks use
 * a text label and retain the same block-level copy control.
 */
function MarkdownPre({
  children,
  ...rest
}: ComponentPropsWithoutRef<"pre">) {
  const codeChild =
    isValidElement<{ className?: string; children?: ReactNode }>(children)
      ? children
      : null;
  const language = codeChild?.props.className?.match(/language-(\S+)/u)?.[1];
  const text = codeBlockText(codeChild?.props.children ?? children);
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
  return (
    <div className="code-block">
      <header>
        <span className="code-block-lang">{language ?? "text"}</span>
        <button
          type="button"
          className={`code-block-copy ${copied ? "is-copied" : ""}`}
          title={copied ? t("복사됨") : t("복사")}
          onClick={() => void copy()}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </header>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS = { pre: MarkdownPre };

// One array for every document. The synchronous renderer parses on each call, so a
// fresh array would not by itself skip a parse, but a memoized document skips the
// call. The same array is what the hooks renderer keys its effect on.
export const MarkdownBody = memo(function MarkdownBody({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
});

export function StreamingMarkdown({ content }: { content: string }) {
  const stateRef = useRef<
    ReturnType<typeof streamingMarkdownState> | undefined
  >(undefined);
  const state = streamingMarkdownState(content, stateRef.current);
  stateRef.current = state;
  return (
    <>
      {state.blocks.map((block, index) => (
        <MarkdownBody key={index}>{block}</MarkdownBody>
      ))}
      {state.pending ? (
        <span style={{ whiteSpace: "pre-wrap" }}>{state.pending}</span>
      ) : null}
    </>
  );
}
