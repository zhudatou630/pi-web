"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { plantUmlSvgUrl } from "@/lib/plantuml";
import { ImagePreview } from "./ImagePreview";
import { CodeBlock, CodeBlockFrame, PreviewToggleButton } from "./MermaidBlock";

export function PlantUmlBlock({ code, lang, isStreaming }: { code: string; lang: string; isStreaming?: boolean }) {
  const { t } = useI18n();
  const [approvedCode, setApprovedCode] = useState<string | null>(null);
  const showPreview = !isStreaming && approvedCode === code;
  // Revoke approval on a rewrite even if the old source later reappears.
  if (approvedCode !== null && !showPreview) setApprovedCode(null);

  const renderLabel = t("chat.renderPlantUml");
  const toggle = code.trim() && (
    <PreviewToggleButton
      isStreaming={isStreaming}
      previewVisible={showPreview}
      onToggle={() => setApprovedCode(showPreview ? null : code)}
      title={showPreview ? t("chat.showPlantUmlSource") : renderLabel}
      previewLabel={renderLabel}
    />
  );
  if (!showPreview) return <CodeBlock code={code} lang={lang} headerAction={toggle} isStreaming={isStreaming} />;
  return (
    <CodeBlockFrame lang={lang} actions={toggle}>
      <PlantUmlPreview code={code} />
    </CodeBlockFrame>
  );
}

type PreviewState =
  | { url: string; loaded: boolean }
  | { error: "chat.plantUmlTooLong" | "chat.plantUmlEncodeFailed" | "chat.plantUmlLoadFailed" };

function PlantUmlPreview({ code }: { code: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<PreviewState | null>(null);
  useEffect(() => {
    let cancelled = false;
    plantUmlSvgUrl(code).then((url) => {
      if (!cancelled) setState(url ? { url, loaded: false } : { error: "chat.plantUmlTooLong" });
    }, () => {
      if (!cancelled) setState({ error: "chat.plantUmlEncodeFailed" });
    });
    return () => { cancelled = true; };
  }, [code]);

  if (state && "error" in state) return <div className="mermaid-block mermaid-block-error" role="status">{t(state.error)}</div>;
  const alt = t("chat.plantUmlDiagram");
  return (
    <>
      {!state?.loaded && <div className="mermaid-block mermaid-block-loading" role="status" aria-label={t("chat.renderingPlantUml")} />}
      {state && (
        <div className="mermaid-block" hidden={!state.loaded}>
          <ImagePreview className="mermaid-preview-button" src={state.url} alt={alt} referrerPolicy="no-referrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              referrerPolicy="no-referrer"
              src={state.url}
              alt={alt}
              onLoad={() => setState({ url: state.url, loaded: true })}
              onError={() => setState({ error: "chat.plantUmlLoadFailed" })}
            />
          </ImagePreview>
        </div>
      )}
    </>
  );
}
