"use client";

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { iconStroke } from "./iconStroke";
import { CopyGlyph } from "./CopyGlyph";
import { ExportImageIcon, useExportImage } from "./ExportImage";
import ReactMarkdown, { type Components } from "react-markdown";
import { pdfPageFromHref, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { parsePreviewTarget, requestPreview } from "@/lib/preview-target";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownAppUrlTransform, markdownRehypePlugins, markdownRemarkPlugins, markdownUserRemarkPlugins, markdownUrlTransform, normalizeDisplayMath } from "@/lib/markdown";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";
import { findHeadingBySlug } from "@/lib/markdown-outline";
import { ImagePreview } from "./ImagePreview";
import { MarkdownCopyButton } from "./MarkdownCopyButton";
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

function MathDisplay({ source, children }: { source: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="markdown-math-display">
      {children}
      <div className="markdown-code-actions markdown-math-copy" data-export-exclude>
        <MarkdownCopyButton text={source} label={t("chat.copyLatex")} />
      </div>
    </div>
  );
}

interface MarkdownBlockProps {
  markdown: string;
  remarkPlugins: typeof markdownRemarkPlugins;
  urlTransform: typeof markdownUrlTransform;
  components: Components;
}

/** One parse; skipped while its text and renderers stay the same. */
const MarkdownBlock = memo(function MarkdownBlock({ markdown, remarkPlugins, urlTransform, components }: MarkdownBlockProps) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={markdownRehypePlugins}
      urlTransform={urlTransform}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  );
});

export const MarkdownBody = memo(function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile }: MarkdownBodyProps) {
  const sessionId = useContext(MarkdownSessionContext);
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  // A streaming reply grows by a few characters per chunk; parsing all of it each
  // time made a long reply quadratic. Its finished blocks keep their parse and only
  // the last is parsed again. A finished message is one block, so node offsets
  // (table copy, shown only then) stay relative to the whole message.
  const blocks = useMemo(
    () => (isStreaming ? splitMarkdownBlocks(normalizedMarkdown) : [normalizedMarkdown]),
    [isStreaming, normalizedMarkdown],
  );
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
      // Agents often quote the dev-server address as code: `http://localhost:5173`.
      const localUrl = /^https?:\/\/\S+$/i.test(raw) ? parsePreviewTarget(raw) : null;
      if (localUrl) {
        return (
          <a href={localUrl.href} target="_blank" rel="noopener noreferrer" onClick={(event) => openLocalUrl(event, localUrl.href)}>
            <code className="markdown-inline-code" {...props}>{children}</code>
          </a>
        );
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
      if (href?.startsWith("#")) {
        return <a href={href} {...props} onClick={(event) => {
          event.preventDefault();
          scrollMarkdownFragment(event.currentTarget);
        }}>{children}</a>;
      }
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        const localUrl = href && /^https?:\/\//i.test(href) ? parsePreviewTarget(href) : null;
        return (
          <a href={href} {...props} target="_blank" rel="noopener noreferrer" onClick={localUrl ? (event) => openLocalUrl(event, localUrl.href) : undefined}>
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
    div({ node, children, ...props }) {
      const source = node?.properties?.dataMathSource;
      if (typeof source === "string") return <MathDisplay source={source}>{children}</MathDisplay>;
      return <div {...props}>{children}</div>;
    },
    table({ children, node }) {
      const start = node?.position?.start.offset;
      const end = node?.position?.end.offset;
      return (
        <MarkdownTableBlock
          actions={!isStreaming}
          getSource={start !== undefined && end !== undefined ? () => tableSource(sourceRef.current, start, end) : undefined}
        >
          {children}
        </MarkdownTableBlock>
      );
    },
  }), [cwd, isStreaming, onOpenFile, sessionId]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      {blocks.map((block, index) => (
        <MarkdownBlock
          key={index}
          markdown={block}
          remarkPlugins={className?.split(/\s+/).includes("markdown-user-message") ? markdownUserRemarkPlugins : markdownRemarkPlugins}
          urlTransform={onOpenFile ? markdownUrlTransform : markdownAppUrlTransform}
          components={components}
        />
      ))}
    </div>
  );
});

/** Sanitized ids gain one prefix, including footnote ids that already carried one. */
export function scrollMarkdownFragment(link: HTMLAnchorElement): void {
  const href = link.getAttribute("href");
  const root = link.closest<HTMLElement>(".markdown-body");
  if (!root || !href?.startsWith("#")) return;
  let slug: string;
  try { slug = decodeURIComponent(href.slice(1)); } catch { return; }
  const headings = [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")];
  const target = slug === "" ? root : [...root.querySelectorAll<HTMLElement>("[id]")].find((element) => element.id === `user-content-${slug}`)
    ?? headings[findHeadingBySlug(headings.map((element) => element.textContent ?? ""), slug)];
  target?.scrollIntoView({ block: "start", inline: "nearest" });
}

/** A plain click on a Pi Web machine address opens Pi Web's browser tab; modified clicks stay normal links. */
function openLocalUrl(event: MouseEvent<HTMLAnchorElement>, url: string): void {
  if (shouldOpenLocalFileInApp(event) && !event.metaKey && !event.ctrlKey && requestPreview(url)) event.preventDefault();
}

/** A table's Markdown, without the quote or list prefix it carries when nested. */
export function tableSource(markdown: string, start: number, end: number): string {
  // Continuation lines repeat the first line's prefix with list markers ("- ", "12. ") turned into indentation.
  const prefix = markdown.slice(markdown.lastIndexOf("\n", start - 1) + 1, start)
    .replace(/[-*+]|\d+[.)]/g, (marker) => " ".repeat(marker.length));
  const lines = markdown.slice(start, end).split("\n");
  return prefix ? lines.map((line, index) => (index > 0 && line.startsWith(prefix) ? line.slice(prefix.length) : line)).join("\n") : lines.join("\n");
}

/** A Markdown table with copy-as-Markdown (when its source is known) and export-as-image chips. */
export function MarkdownTableBlock({ children, actions = true, getSource }: { children: ReactNode; actions?: boolean; getSource?: () => string }) {
  return (
    <div className="markdown-table-block">
      <div className="markdown-table-frame">
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      </div>
      {actions && (
        <div className="markdown-table-actions">
          {/* The table exactly as written, so a paste keeps its Markdown. */}
          {getSource && <TableCopyButton getSource={getSource} />}
          <TableExportButton />
        </div>
      )}
    </div>
  );
}

function TableExportButton() {
  const image = useExportImage();
  return (
    <button
      type="button"
      className="markdown-table-copy"
      data-copied={image.done ? "true" : undefined}
      disabled={image.busy}
      title={image.title}
      aria-label={image.title}
      onClick={(event) => image.run(event.currentTarget.closest<HTMLElement>(".markdown-table-block"), "pi-table.png")}
    >
      <ExportImageIcon done={image.done} />
    </button>
  );
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
