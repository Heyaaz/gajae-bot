import remarkGfm from "remark-gfm";
import type { Options } from "react-markdown";

// Korean range notation (`10~11시`, `1.4만~4만`) must stay literal text.
// remark-gfm treats a single tilde pair as strikethrough by default.
export const MARKDOWN_REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [
  [remarkGfm, { singleTilde: false }],
];
