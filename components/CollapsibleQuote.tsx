"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "./MarkdownBody";

/**
 * Instructions shown as a quoted passage (hairline rule, secondary text), or as plain body text:
 * past a few lines it fades out and offers "Show all". Used by the approval card and overview.
 */
export function CollapsibleQuote({ text, plain = false }: {
  text: string;
  /** Body text at reading size, without the quote rule (the overview shows the routine's own words). */
  plain?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const quoteRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const quote = quoteRef.current;
    if (quote && !expanded) setOverflows(quote.scrollHeight > quote.clientHeight + 1);
  }, [text, expanded]);

  return (
    <>
      <div ref={quoteRef} className={`routine-quote${plain ? " is-plain" : ""}${expanded ? " is-expanded" : overflows ? " is-clipped" : ""}`}>
        <MarkdownBody>{text}</MarkdownBody>
      </div>
      {(overflows || expanded) && (
        <button type="button" className="routine-quote-more" onClick={() => setExpanded((value) => !value)}>
          {t(expanded ? "routines.approval.less" : "routines.approval.more")}
        </button>
      )}
    </>
  );
}
