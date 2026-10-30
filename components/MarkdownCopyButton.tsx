"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { CopyGlyph } from "./CopyGlyph";
import { iconStroke } from "./iconStroke";

/** Shared source-copy action for fenced code and display math. */
export function MarkdownCopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const title = copied ? t("i18n.copied") : label ?? t("i18n.copy");
  return (
    <button
      type="button"
      className="markdown-code-action"
      data-copied={copied ? "true" : undefined}
      title={title}
      aria-label={title}
      onClick={() => {
        copyText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={iconStroke(12)} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {copied ? <polyline points="20 6 9 17 4 12" /> : <CopyGlyph />}
      </svg>
      <span>{copied ? t("i18n.copied") : t("i18n.copy")}</span>
    </button>
  );
}
