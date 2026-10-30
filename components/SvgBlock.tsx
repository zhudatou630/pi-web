"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ImagePreview } from "./ImagePreview";
import { CodeBlock, downloadSvgFile, PreviewToggleButton } from "./MermaidBlock";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Validate as XML, never as HTML; the result is used only as an image URL. */
export function svgImageSource(code: string): string | null {
  const doc = new DOMParser().parseFromString(code, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  const root = doc.documentElement;
  if (root?.localName !== "svg") return null;
  if (root.namespaceURI === null) {
    root.setAttribute("xmlns", SVG_NS);
    return new XMLSerializer().serializeToString(root);
  }
  return root.namespaceURI === SVG_NS ? code : null;
}

export function SvgBlock({ code, isStreaming }: { code: string; isStreaming?: boolean }) {
  const { t } = useI18n();
  const [parsed, setParsed] = useState<{ code: string; source: string | null } | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  // Keep server rendering and hydration identical; incomplete streaming XML stays source.
  useEffect(() => {
    if (!isStreaming) setParsed({ code, source: svgImageSource(code) });
  }, [code, isStreaming]);
  const source = parsed?.code === code ? parsed.source : null;
  const previewVisible = showPreview && !isStreaming;
  const toggle = (
    <PreviewToggleButton
      isStreaming={isStreaming}
      previewVisible={previewVisible}
      onToggle={() => setShowPreview((value) => !value)}
      title={previewVisible ? t("chat.showSvgSource") : t("chat.previewSvg")}
    />
  );
  if (!source || source === failedSource || !previewVisible) {
    return <CodeBlock code={code} lang="svg" isStreaming={isStreaming} headerAction={isStreaming || (source && source !== failedSource) ? toggle : undefined} />;
  }
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">svg</span>
        <div className="markdown-code-actions">
          <button
            type="button"
            className="markdown-code-action"
            title={`${t("i18n.downloadFile")} (SVG)`}
            aria-label={`${t("i18n.downloadFile")} (SVG)`}
            onClick={() => downloadSvgFile(source, "image.svg")}
          >
            SVG
          </button>
          {toggle}
        </div>
      </div>
      <div className="mermaid-block">
        <ImagePreview src={src} alt={t("chat.svgImage")} style={{ width: "100%" }}>
          {/* SVG scripts and external resources are inert in an image, never insert this XML as DOM. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={t("chat.svgImage")} onError={() => setFailedSource(source)} />
        </ImagePreview>
      </div>
    </div>
  );
}
