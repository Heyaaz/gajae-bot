import ReactMarkdown from "react-markdown";
import { streamingMarkdownState } from "../transcript-utils";
import { MARKDOWN_REMARK_PLUGINS } from "./markdown-plugins";
import { isValidElement, memo, useRef } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { CodeCopyButton } from "./code-copy-button";
import { MermaidBlock } from "./mermaid-diagram";

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
 *
 * A complete `mermaid` fence is drawn as a diagram when `diagrams` is on, and the
 * code block built here stays as its loading and failure view.
 */
function codeBlockView(
  { children, ...rest }: ComponentPropsWithoutRef<"pre">,
  diagrams: boolean,
) {
  const codeChild =
    isValidElement<{ className?: string; children?: ReactNode }>(children)
      ? children
      : null;
  const language = codeChild?.props.className?.match(/language-(\S+)/u)?.[1];
  const text = codeBlockText(codeChild?.props.children ?? children);
  const pre = <pre {...rest}>{children}</pre>;
  const block = (
    <div className="code-block">
      <header>
        <span className="code-block-lang">{language ?? "text"}</span>
        <CodeCopyButton text={text} />
      </header>
      {pre}
    </div>
  );
  if (diagrams && language === "mermaid")
    return <MermaidBlock source={text} fallback={block} sourcePre={pre} />;
  return block;
}

const MARKDOWN_COMPONENTS = {
  pre: (props: ComponentPropsWithoutRef<"pre">) => codeBlockView(props, true),
};

// A reply still streaming may end mid-diagram, so its blocks stay plain code until
// the settled message replaces them.
const STREAMING_MARKDOWN_COMPONENTS = {
  pre: (props: ComponentPropsWithoutRef<"pre">) => codeBlockView(props, false),
};

// One array for every document. The synchronous renderer parses on each call, so a
// fresh array would not by itself skip a parse, but a memoized document skips the
// call. The same array is what the hooks renderer keys its effect on.
export const MarkdownBody = memo(function MarkdownBody({
  children,
  streaming = false,
}: {
  children: string;
  streaming?: boolean;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      components={streaming ? STREAMING_MARKDOWN_COMPONENTS : MARKDOWN_COMPONENTS}
    >
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
        <MarkdownBody key={index} streaming>
          {block}
        </MarkdownBody>
      ))}
      {state.pending ? (
        <span style={{ whiteSpace: "pre-wrap" }}>{state.pending}</span>
      ) : null}
    </>
  );
}
