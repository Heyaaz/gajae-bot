import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { t } from "../i18n";

/** The one-click copy control shared by every fenced block's header. */
export function CodeCopyButton({ text }: { text: string }) {
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
    <button
      type="button"
      className={`code-block-copy ${copied ? "is-copied" : ""}`}
      title={copied ? t("복사됨") : t("복사")}
      onClick={() => void copy()}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
