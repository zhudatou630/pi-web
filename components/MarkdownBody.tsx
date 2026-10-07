"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { iconStroke } from "./iconStroke";
import { CopyGlyph } from "./CopyGlyph";
import ReactMarkdown, { type Components } from "react-markdown";
import { pdfPageFromHref, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownRehypePlugins, markdownRemarkPlugins, markdownUrlTransform, normalizeDisplayMath } from "@/lib/markdown";
import { ImagePreview } from "./ImagePreview";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";

/** Session whose messages are rendered; lets the file API serve images the session references outside allowed roots. */
export const MarkdownSessionContext = createContext<string | null>(null);

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
}

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile }: MarkdownBodyProps) {
  const sessionId = useContext(MarkdownSessionContext);
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  // Read at click time so the renderers below keep their identity while text streams.
  const sourceRef = useRef(normalizedMarkdown);
  useEffect(() => { sourceRef.current = normalizedMarkdown; }, [normalizedMarkdown]);
  // Stable renderer identities keep stateful blocks mounted across message hover updates.
  const components = useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          return (
            <MermaidBlock
              code={raw.replace(/\n$/, "")}
              isStreaming={isStreaming}
              defaultPreview
            />
          );
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={isStreaming} />;
      }
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <a href={href} {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }
      // `report.pdf#page=12` must open on page 12: the fragment is dropped when
      // the href becomes a filesystem path, so carry it alongside.
      const page = pdfPageFromHref(href);

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!shouldOpenLocalFileInApp(event)) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath, page ?? undefined);
      };

      return (
        <a href={href} {...props} onClick={handleClick}>
          {children}
        </a>
      );
    },
    img({ src, alt, ...props }) {
      delete props.node;
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      const imageSrc = filePath
        ? `/api/files/${encodeFilePathForApi(filePath)}?type=read${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`
        : src;
      // Dynamic local paths are served directly by the file API.
      return (
        <ImagePreview src={typeof imageSrc === "string" ? imageSrc : ""} alt={alt ?? ""} style={{ width: "fit-content", maxWidth: "100%" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />
        </ImagePreview>
      );
    },
    table({ children, node }) {
      const start = node?.position?.start.offset;
      const end = node?.position?.end.offset;
      return (
        <div className="markdown-table-block">
          <div className="markdown-table-wrap">
            <table>{children}</table>
          </div>
          {!isStreaming && start !== undefined && end !== undefined && (
            // The table exactly as written in the message, so a paste keeps its Markdown.
            <TableCopyButton getSource={() => tableSource(sourceRef.current, start, end)} />
          )}
        </div>
      );
    },
  }), [cwd, isStreaming, onOpenFile, sessionId]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        urlTransform={onOpenFile ? markdownUrlTransform : undefined}
        components={components}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}

/** A table's Markdown, without the quote or list prefix it carries when nested. */
export function tableSource(markdown: string, start: number, end: number): string {
  // Continuation lines repeat the first line's prefix with list markers ("- ", "12. ") turned into indentation.
  const prefix = markdown.slice(markdown.lastIndexOf("\n", start - 1) + 1, start)
    .replace(/[-*+]|\d+[.)]/g, (marker) => " ".repeat(marker.length));
  const lines = markdown.slice(start, end).split("\n");
  return prefix ? lines.map((line, index) => (index > 0 && line.startsWith(prefix) ? line.slice(prefix.length) : line)).join("\n") : lines.join("\n");
}

function TableCopyButton({ getSource }: { getSource: () => string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const label = copied ? t("i18n.copied") : t("chat.copyTable");
  return (
    <button
      type="button"
      className="markdown-table-copy"
      data-copied={copied ? "true" : undefined}
      title={label}
      aria-label={label}
      onClick={() => {
        copyText(getSource()).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={iconStroke(12)} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {copied ? <polyline points="20 6 9 17 4 12" /> : <CopyGlyph />}
      </svg>
    </button>
  );
}
