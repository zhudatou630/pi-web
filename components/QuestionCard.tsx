"use client";

import { useId, useRef, useState } from "react";
import { parseStreamingJson } from "@earendil-works/pi-ai";
import { useI18n } from "@/hooks/useI18n";
import { formatAskUserAnswer, matchAskUserOptions } from "@/lib/ask-user-answer";
import type { ToolCallContent, ToolResultMessage } from "@/lib/types";
import { ConfigButton } from "./SettingsUi";

export function QuestionCard({ block, result, answer = null, active = false, onAnswer }: {
  block: ToolCallContent;
  result?: ToolResultMessage;
  answer?: string | null;
  active?: boolean;
  onAnswer?: (answer: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const input = result?.details && typeof result.details === "object" ? result.details as Record<string, unknown>
    : block.rawInput !== undefined ? parseStreamingJson<Record<string, unknown>>(block.rawInput) : block.input;
  const question = typeof input?.question === "string" ? input.question : "";
  const options = Array.isArray(input?.options) ? input.options.filter((option): option is string => typeof option === "string") : [];
  const multiSelect = input?.multi_select === true;
  const chosen = answer === null ? [] : matchAskUserOptions(options, answer);
  const interactive = active && answer === null && !!result && !result.isError && !!onAnswer
    && !!question.trim() && options.length >= 2 && options.length <= 6 && options.every((option) => option.trim());
  const muted = answer !== null && chosen.length === 0;
  const submit = async (labels: string[]) => {
    if (!interactive || !onAnswer || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await onAnswer(formatAskUserAnswer(labels));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <section className="question-card" aria-labelledby={headingId} aria-busy={sending || undefined}>
      <h3 id={headingId} className="question-card-heading">{question}</h3>
      <div className="question-card-options">
        {options.map((option, index) => {
          if (chosen.length > 0 && !chosen.includes(option)) return null;
          const checked = chosen.includes(option) || (answer === null && selected.includes(option));
          const content = <><span className={`question-card-badge${checked ? " is-chosen" : ""}`} aria-hidden="true">{String.fromCharCode(65 + index)}</span><span>{option}</span></>;
          return interactive ? (
            <button
              key={index}
              type="button"
              className="question-card-option"
              role={multiSelect ? "checkbox" : undefined}
              aria-checked={multiSelect ? checked : undefined}
              disabled={sending}
              onClick={() => multiSelect
                ? setSelected((previous) => previous.includes(option) ? previous.filter((label) => label !== option) : [...previous, option])
                : void submit([option])}
            >{content}</button>
          ) : <div key={index} className={`question-card-option${muted ? " is-muted" : ""}`}>{content}</div>;
        })}
      </div>
      {/* Multi-select only: a single choice sends on click. Free text goes in the composer, as always. */}
      {interactive && multiSelect && <div className="question-card-footer" data-export-exclude>
        <ConfigButton variant="primary" size="small" disabled={sending || selected.length === 0} onClick={() => void submit(options.filter((option) => selected.includes(option)))}>{t("chat.question.send")}</ConfigButton>
      </div>}
    </section>
  );
}
