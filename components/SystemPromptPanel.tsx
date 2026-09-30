type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  prompt: string | null;
  translate: Translate;
}

/** Body of the system prompt dialog: the prompt verbatim, or why there is none. */
export function SystemPromptPanel({ loading, prompt, translate }: Props) {
  return (
    <section className="system-prompt-scroll" aria-label={translate("system.prompt")}>
      {prompt ? (
        <div className="system-prompt-text">{prompt}</div>
      ) : (
        <div className="system-prompt-empty">
          {prompt === ""
            ? translate("system.empty")
            : loading
              ? translate("system.loading")
              : translate("system.load")}
        </div>
      )}

      <style>{`
        .system-prompt-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 14px 18px 18px;
        }
        .system-prompt-text {
          color: var(--text);
          font-family: var(--font-mono);
          font-size: 13px;
          line-height: 1.6;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }
        @media (max-width: 640px) {
          .system-prompt-scroll {
            padding: 16px 16px 32px;
          }
        }
        .system-prompt-empty {
          color: var(--text-muted);
          font-size: 12px;
          line-height: 1.5;
        }
      `}</style>
    </section>
  );
}
