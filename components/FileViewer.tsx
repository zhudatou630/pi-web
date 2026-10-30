"use client";

import { FileWatchEventSource as EventSource } from "@/lib/file-watch-client";
import { memo, useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import renderSyntaxNode from "react-syntax-highlighter/dist/esm/create-element";
// Direct theme imports: the styles/prism barrel pulls in all ~44 themes.
import vs from "react-syntax-highlighter/dist/esm/styles/prism/vs";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";
import ReactMarkdown from "react-markdown";
import { createPortal } from "react-dom";
import { findQuoteInSegments, selectedTextWithTex } from "@/lib/quoted-selection";
import { useTheme } from "@/hooks/useTheme";
import { usePrismLanguages } from "@/hooks/usePrismLanguages";
import { claudeCodeStyle, claudeDarkCodeStyle } from "@/lib/claude-theme";
import {
  BINARY_FILE_ERROR,
  DOCX_PREVIEW_MAX_BYTES,
  getFileExt,
  isAudioPath,
  isDocumentPreviewPath,
  isFilePreviewPath,
  isImagePath,
  isVideoPath,
} from "@/lib/file-types";
import { encodeFilePathForApi, getFileDirectory, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { pdfPageFromHref, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { parseFrontmatter } from "@/lib/frontmatter";
import { extractMarkdownOutline, findHeadingBySlug } from "@/lib/markdown-outline";
import { markdownAppUrlTransform, markdownPreviewRehypePlugins, markdownPreviewRemarkPlugins, markdownUrlTransform, normalizeDisplayMath } from "@/lib/markdown";
import { CodeBlock, MermaidBlock } from "./MermaidBlock";
import { SvgBlock } from "./SvgBlock";
import { MarkdownTableBlock, tableSource } from "./MarkdownBody";
import { DelimitedTable } from "./DelimitedTable";
import { isDelimitedTablePath } from "@/lib/delimited-table";
import { FrontmatterCard } from "./FrontmatterCard";
import { MarkdownOutlineMenu } from "./MarkdownOutlineMenu";
import { FileFindBar, scrollIntoScroller } from "./FileFindBar";
import { ImageViewer as ImageLightbox } from "./ImageViewer";
import { ImagePreview } from "./ImagePreview";
import { MarkdownMedia } from "./MarkdownMedia";
import { parseUnifiedPatch } from "@/lib/patch";
import type { GitFileDiffResponse } from "@/lib/git-types";
import { readTextChunks, type TextChunk } from "@/lib/text-chunk-reader";
import { useI18n } from "@/hooks/useI18n";
import { useConfirm } from "@/hooks/useConfirm";
import { placeSelectionToolbar, prefersToolbarBelow, selectionAnchor, visibleBounds, type SelectionAnchor } from "@/lib/selection-toolbar";
import {
  resolveInitialFileDisplayMode,
  type FileViewerDisplayMode as DisplayMode,
  type FileViewerState,
} from "@/lib/file-viewer-state";

export type { FileViewerState } from "@/lib/file-viewer-state";

function resolveFileDisplayMode(
  filePath: string,
  initialState?: FileViewerState,
  initialDisplayMode?: DisplayMode,
): DisplayMode {
  return resolveInitialFileDisplayMode(
    initialState,
    initialDisplayMode ?? ((isFilePreviewPath(filePath) || isDelimitedTablePath(filePath)) ? "preview" : undefined),
  );
}

interface Props {
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Add the selection to the chat as a quote chip: whole source lines, or markdown preview text. */
  onAttachSelection?: (attachment: FileSelectionAttachment) => void;
  /** Scroll to and mark these source lines, or this preview text, once; then call onRevealed. */
  reveal?: FileReveal;
  onRevealed?: () => void;
  /** Insert this file's relative path into the chat input (@ mention). */
  onAtMention?: (relativePath: string, isDir: boolean, sourceCwd?: string) => void;
  gitRefreshKey?: number;
  initialDisplayMode?: DisplayMode;
  initialState?: FileViewerState;
  onStateChange?: (state: FileViewerState) => void;
  watchEnabled?: boolean;
  /** PDF page to open, from a `#page=` link fragment. */
  pdfPage?: number;
}

export type FileReveal = { start: number; end: number } | { text: string };

export interface FileSelectionAttachment {
  relativePath: string;
  text: string;
  sourceCwd?: string;
  startLine?: number;
  endLine?: number;
}

interface FileData extends TextChunk {
  language: string;
  size: number;
}

const PREVIEW_AUTOLOAD_MAX_BYTES = 4 * 1024 * 1024;
// A larger HTML file (a standalone Plotly report) stays chunked in Source; its
// preview fetches the whole file once, up to this cap.
const HTML_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
// "Load more" reads to the end; past this size the whole file stays in page state, so ask first.
const LOAD_ALL_CONFIRM_BYTES = 16 * 1024 * 1024;
const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;
const WATCH_CHANGE_DEBOUNCE_MS = 150;
const FIND_SHORTCUT_LABEL = "Ctrl/⌘ F";
const SOURCE_HIGHLIGHT_MAX_BYTES = 128 * 1024;
const FILE_CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "calc(13px + var(--chat-font-size-offset, 0px))",
  lineHeight: 1.6,
};

const FILE_LINE_NUMBER_STYLE: CSSProperties = {
  boxSizing: "border-box",
  width: 48,
  minWidth: 48,
  padding: "0 10px",
  textAlign: "right",
  color: "var(--text-dim)",
  background: "var(--bg-panel)",
  borderRight: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: "calc(11px + var(--chat-font-size-offset, 0px))",
  fontStyle: "normal",
  fontVariantNumeric: "tabular-nums",
  // Match the code line box despite the smaller metadata font (including zoom).
  lineHeight: "calc((13px + var(--chat-font-size-offset, 0px)) * 1.6)",
  userSelect: "none",
  flexShrink: 0,
  verticalAlign: "top",
};

// shortcut: cap sticky cells at 1,000 rows; virtualize before pinning larger views.
const FILE_PINNED_LINE_NUMBER_STYLE: CSSProperties = {
  ...FILE_LINE_NUMBER_STYLE,
  position: "sticky",
  left: 0,
  zIndex: 1,
};

const FILE_DIFF_LINE_NUMBER_STYLE: CSSProperties = {
  ...FILE_LINE_NUMBER_STYLE,
  width: 40,
  minWidth: 40,
  paddingInline: 6,
};

type SourceCodeRendererProps = Parameters<NonNullable<SyntaxHighlighterProps["renderer"]>>[0] & {
  wrapLines: boolean;
};

interface SelectedLineRange {
  startLine: number;
  endLine: number;
}

function sameAttachment(a: FileSelectionAttachment | null, b: FileSelectionAttachment | null): boolean {
  return a === b || (a !== null && b !== null && a.text === b.text && a.startLine === b.startLine && a.endLine === b.endLine);
}

function MentionIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function closestSourceLine(node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return element?.closest<HTMLElement>(".file-source-line[data-line-number]") ?? null;
}

function getSelectedSourceLineRange(root: HTMLElement, selection: Selection | null): SelectedLineRange | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  let startElement = closestSourceLine(range.startContainer);
  let endElement = closestSourceLine(range.endContainer);
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) return null;

  let startLine = Number(startElement.dataset.lineNumber);
  let endLine = Number(endElement.dataset.lineNumber);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;

  if (startLine < endLine) {
    // Browser ranges can start at the end of the preceding line or end at the
    // start of the following line. Exclude either boundary line when none of
    // its source text is actually selected.
    const startContent = startElement.querySelector<HTMLElement>(".file-source-line-content");
    if (startContent?.contains(range.startContainer)) {
      const selectedSuffix = document.createRange();
      selectedSuffix.selectNodeContents(startContent);
      selectedSuffix.setStart(range.startContainer, range.startOffset);
      if (selectedSuffix.toString().length === 0) {
        const nextLine = root.querySelector<HTMLElement>(`.file-source-line[data-line-number="${startLine + 1}"]`);
        if (nextLine) {
          startElement = nextLine;
          startLine = Number(startElement.dataset.lineNumber);
        }
      }
    }

    const endContent = endElement.querySelector<HTMLElement>(".file-source-line-content");
    if (endContent?.contains(range.endContainer)) {
      const selectedPrefix = document.createRange();
      selectedPrefix.selectNodeContents(endContent);
      selectedPrefix.setEnd(range.endContainer, range.endOffset);
      if (selectedPrefix.toString().length === 0) {
        const previousLine = root.querySelector<HTMLElement>(`.file-source-line[data-line-number="${endLine - 1}"]`);
        if (previousLine) {
          endElement = previousLine;
          endLine = Number(endElement.dataset.lineNumber);
        }
      }
    }
  }

  if (startLine > endLine) return null;
  return { startLine, endLine };
}

const SOURCE_CHUNK_LINES = 100;

// Wrapped lines reflow on every width change; chunks let the browser skip offscreen
// ones (content-visibility in globals.css). Per-line skipping costs more than it saves.
function chunkSourceLines(lines: ReactNode[]): ReactNode[] {
  const chunks: ReactNode[] = [];
  for (let start = 0; start < lines.length; start += SOURCE_CHUNK_LINES) {
    chunks.push(<span className="file-source-chunk" key={`source-chunk-${start}`}>{lines.slice(start, start + SOURCE_CHUNK_LINES)}</span>);
  }
  return chunks;
}

function SourceCodeRenderer({ rows, stylesheet, useInlineStyles, wrapLines }: SourceCodeRendererProps) {
  return chunkSourceLines(rows.map((row, lineIndex) => {
    const children = row.children ?? [];
    const firstChildClasses = children[0]?.properties?.className;
    const hasLineNumber = Array.isArray(firstChildClasses)
      && firstChildClasses.includes("react-syntax-highlighter-line-number");
    const lineNumberNode = hasLineNumber ? children[0] : null;
    const contentNodes = hasLineNumber ? children.slice(1) : children;

    return (
      <span
        className="file-source-line"
        data-line-number={lineIndex + 1}
        key={`source-line-${lineIndex}`}
        style={{ display: "flex", minWidth: "100%" }}
      >
        {lineNumberNode && renderSyntaxNode({
          node: lineNumberNode,
          stylesheet,
          useInlineStyles,
          key: `source-line-number-${lineIndex}`,
        })}
        <span
          className="file-source-line-content"
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflowWrap: wrapLines ? "anywhere" : "normal",
            whiteSpace: wrapLines ? "pre-wrap" : "pre",
          }}
        >
          {contentNodes.map((node, tokenIndex) => renderSyntaxNode({
            node,
            stylesheet,
            useInlineStyles,
            key: `source-token-${lineIndex}-${tokenIndex}`,
          }))}
        </span>
      </span>
    );
  }));
}

function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "preview" | "watch",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encoded}?${searchParams.toString()}`;
}

function MentionButton({ filePath, cwd, onAtMention }: Pick<Props, "filePath" | "cwd" | "onAtMention">) {
  const { t } = useI18n();
  if (!onAtMention) return null;
  return (
    <button
      type="button"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => onAtMention(getRelativeFilePath(filePath, cwd), false, cwd)}
      title={t("files.insertPath")}
      aria-label={t("files.mention")}
      className="file-viewer-icon-button"
    >
      <MentionIcon />
    </button>
  );
}

function MediaToolbar({ filePath, cwd, sourceSessionId, meta, watching, onAtMention }: Pick<Props, "filePath" | "cwd" | "sourceSessionId" | "onAtMention"> & {
  meta: Array<string | false | null | undefined>;
  watching: boolean;
}) {
  const { t } = useI18n();
  const metadata = meta.filter(Boolean).join(" · ");
  return (
    <div
      className="file-viewer-toolbar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px 5px 12px",
        borderBottom: "1px solid var(--border)",
        fontSize: 11,
        color: "var(--text-dim)",
        background: "var(--bg)",
        flexShrink: 0,
      }}
    >
      <span className="file-viewer-path" title={filePath}>{getRelativeFilePath(filePath, cwd)}</span>
      <span className="file-viewer-meta" title={metadata}>{metadata}</span>
      <span
        title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
        aria-label={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
        className="file-viewer-live-indicator"
        style={{
          background: watching ? "var(--success)" : "var(--border)",
          boxShadow: watching ? "0 0 4px var(--success)" : "none",
        }}
      />
      <div className="file-viewer-controls">
        {onAtMention && (
          <div className="file-viewer-actions">
            <MentionButton filePath={filePath} cwd={cwd} onAtMention={onAtMention} />
          </div>
        )}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
    </div>
  );
}

function DownloadLink({ filePath, sourceSessionId }: { filePath: string; sourceSessionId?: string | null }) {
  const { t } = useI18n();
  return (
    <a
      href={getFileApiUrl(filePath, "download", sourceSessionId)}
      download={getFileName(filePath)}
      title={t("i18n.downloadFile")}
      aria-label={t("i18n.downloadFile")}
      className="file-viewer-icon-button"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </a>
  );
}

type DiffLine =
  | { type: "hunk"; text: string }
  | {
      type: "unchanged" | "removed" | "added";
      text: string;
      oldLineNo: number | null;
      newLineNo: number | null;
    };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function diffLines(patch: string): DiffLine[] {
  const files = parseUnifiedPatch(patch);
  if (!files) return [];

  return files.flatMap((file) => file.rows.flatMap((row): DiffLine[] => {
    if (row.type === "hunk") return [{ type: "hunk", text: row.text }];
    if (row.left.type === "context" && row.right.type === "context") {
      return [{
        type: "unchanged",
        text: row.right.text,
        oldLineNo: row.left.lineNo,
        newLineNo: row.right.lineNo,
      }];
    }

    const lines: DiffLine[] = [];
    if (row.left.type === "removed") {
      lines.push({
        type: "removed",
        text: row.left.text,
        oldLineNo: row.left.lineNo,
        newLineNo: null,
      });
    }
    if (row.right.type === "added") {
      lines.push({
        type: "added",
        text: row.right.text,
        oldLineNo: null,
        newLineNo: row.right.lineNo,
      });
    }
    return lines;
  }));
}

function diffMetadataLines(patch: string): string[] {
  return patch.split(/\r?\n/).filter((line) => /^(?:similarity index|dissimilarity index|rename from|rename to|copy from|copy to|old mode|new mode|new file mode|deleted file mode|Binary files|Submodule )/.test(line));
}

function DiffView({ patch }: { patch: string }) {
  const { t } = useI18n();
  const diff = useMemo(() => diffLines(patch), [patch]);
  const metadata = diffMetadataLines(patch);
  const pinLineNumbers = diff.length <= SOURCE_HIGHLIGHT_MAX_LINES;
  const oldLineNumberStyle: CSSProperties = pinLineNumbers
    ? { ...FILE_DIFF_LINE_NUMBER_STYLE, position: "sticky", left: 0, zIndex: 1 }
    : FILE_DIFF_LINE_NUMBER_STYLE;
  const newLineNumberStyle: CSSProperties = pinLineNumbers
    ? { ...oldLineNumberStyle, left: 40 }
    : FILE_DIFF_LINE_NUMBER_STYLE;

  const hasChanges = metadata.length > 0 || diff.some((line) => line.type === "added" || line.type === "removed");
  if (!hasChanges) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)" }}>
        {t("i18n.noChanges")}
      </div>
    );
  }

  return (
    <div
      className="file-diff-view"
      style={{
        width: "max-content",
        minWidth: "100%",
        ...FILE_CODE_STYLE,
      }}
    >
      {metadata.map((line, lineIndex) => (
        <div key={`${lineIndex}:${line}`} style={{ padding: "2px 12px", color: "var(--text-muted)", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
          {line}
        </div>
      ))}
      {diff.map((line, lineIndex) => {
          if (line.type === "hunk") {
            return (
              <div key={`hunk-${lineIndex}`} style={{ padding: "2px 12px", color: "var(--accent)", background: "var(--bg-panel)", borderBlock: "1px solid var(--border)" }}>
                {line.text}
              </div>
            );
          }
          const bg =
            line.type === "added"
              ? "color-mix(in srgb, var(--success) 12%, transparent)"
              : line.type === "removed"
              ? "color-mix(in srgb, var(--danger) 14%, transparent)"
              : "transparent";
          const prefix =
            line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
          const prefixColor =
            line.type === "added" ? "var(--success)" : line.type === "removed" ? "var(--danger)" : "var(--text-dim)";

          return (
            <div
              key={lineIndex}
              className="file-diff-line"
              style={{
                display: "flex",
                minWidth: "100%",
                background: bg,
              }}
            >
              {/* The change bar sits on the pinned gutter so it stays visible when scrolled sideways. */}
              <span
                style={line.type === "added" || line.type === "removed"
                  ? { ...oldLineNumberStyle, boxShadow: `inset 3px 0 0 ${prefixColor}` }
                  : oldLineNumberStyle}
              >
                {line.oldLineNo}
              </span>
              <span style={newLineNumberStyle}>{line.newLineNo}</span>
              <span
                style={{
                  minWidth: 16,
                  padding: "0 6px",
                  color: prefixColor,
                  userSelect: "none",
                  flexShrink: 0,
                }}
              >
                {prefix}
              </span>
              <span
                className="file-diff-line-content"
                style={{
                  flexShrink: 0,
                  padding: "0 8px 0 0",
                  whiteSpace: "pre",
                  color: "var(--text)",
                }}
              >
                {line.text || "\u00a0"}
              </span>
            </div>
          );
      })}
    </div>
  );
}

function ImageViewer({ filePath, cwd, sourceSessionId, watchEnabled = true, onAtMention }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const syncRequestRef = useRef(0);
  // Version the element last loaded; undefined until the first connect.
  const seenVersionRef = useRef<string | null | undefined>(undefined);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    seenVersionRef.current = undefined;
    setSize(null);
    setNaturalSize(null);
    setError(null);
    setWatching(false);
  }, [filePath, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled) return;

    let active = true;
    const synchronize = (reload: boolean) => {
      const requestId = ++syncRequestRef.current;
      fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
        .then((response) => response.json())
        .then((next: { size?: number; error?: string }) => {
          if (!active || requestId !== syncRequestRef.current) return;
          if (next.error) {
            setError(next.error);
            return;
          }
          if (typeof next.size === "number") setSize(next.size);
          setNaturalSize(null);
          setError(null);
          if (reload) setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (active && requestId === syncRequestRef.current) setError(String(nextError));
        });
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", (event) => {
      setWatching(true);
      // The first connect only refreshes metadata; the element already loaded this file. A reconnect
      // or resumed watch (hidden tab shown again) reloads it only if the file changed meanwhile.
      const version = parseWatchVersion(event);
      const seen = seenVersionRef.current;
      seenVersionRef.current = version;
      synchronize(seen !== undefined && seen !== version);
    });
    es.addEventListener("change", (e) => {
      syncRequestRef.current += 1;
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number; version?: string };
        seenVersionRef.current = d.version ?? null;
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setNaturalSize(null);
      setError(null);
      setBust((b) => b + 1);
    });
    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      active = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, sourceSessionId, watchEnabled]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  const formatSizeStr = size != null ? formatSize(size) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <MediaToolbar
        filePath={filePath}
        cwd={cwd}
        sourceSessionId={sourceSessionId}
        meta={[ext || "image", naturalSize && `${naturalSize.w} × ${naturalSize.h}`, formatSizeStr]}
        watching={watching}
        onAtMention={onAtMention}
      />
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-panel)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          backgroundImage:
            "linear-gradient(45deg, var(--bg) 25%, transparent 25%), linear-gradient(-45deg, var(--bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg) 75%), linear-gradient(-45deg, transparent 75%, var(--bg) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        {error ? (
          <div style={{ color: "var(--danger)", fontSize: 12 }}>{error}</div>
        ) : (
          <ImagePreview src={src} alt={filePath} style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={filePath}
              onLoad={(e) => {
                const img = e.currentTarget;
                setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              onError={() => setError(t("files.imageLoadError"))}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
              }}
            />
          </ImagePreview>
        )}
      </div>
    </div>
  );
}

function parseWatchVersion(event: Event): string | null {
  try {
    return (JSON.parse((event as MessageEvent).data) as { version?: string | null }).version ?? null;
  } catch {
    return null;
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function AudioViewer({ filePath, cwd, sourceSessionId, watchEnabled = true, onAtMention }: Props) {
  const { t } = useI18n();
  const mediaRef = useRef<HTMLAudioElement | null>(null);
  // A hidden tab or closed panel pauses the watch; stop playback with it.
  useEffect(() => {
    if (!watchEnabled) mediaRef.current?.pause();
  }, [watchEnabled]);
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const syncRequestRef = useRef(0);
  // Version the element last loaded; undefined until the first connect.
  const seenVersionRef = useRef<string | null | undefined>(undefined);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    seenVersionRef.current = undefined;
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);
  }, [filePath, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled) return;

    let active = true;
    const synchronize = (reload: boolean) => {
      const requestId = ++syncRequestRef.current;
      fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
        .then((response) => response.json())
        .then((next: { size?: number; error?: string }) => {
          if (!active || requestId !== syncRequestRef.current) return;
          if (next.error) {
            setError(next.error);
            return;
          }
          if (typeof next.size === "number") setSize(next.size);
          setDuration(null);
          setError(null);
          if (reload) setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (active && requestId === syncRequestRef.current) setError(String(nextError));
        });
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", (event) => {
      setWatching(true);
      // The first connect only refreshes metadata; the element already loaded this file. A reconnect
      // or resumed watch (hidden tab shown again) reloads it only if the file changed meanwhile.
      const version = parseWatchVersion(event);
      const seen = seenVersionRef.current;
      seenVersionRef.current = version;
      synchronize(seen !== undefined && seen !== version);
    });
    es.addEventListener("change", (e) => {
      syncRequestRef.current += 1;
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number; version?: string };
        seenVersionRef.current = d.version ?? null;
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      active = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, sourceSessionId, watchEnabled]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <MediaToolbar
        filePath={filePath}
        cwd={cwd}
        sourceSessionId={sourceSessionId}
        meta={[ext || "audio", duration != null && formatDuration(duration), size != null && formatSize(size)]}
        watching={watching}
        onAtMention={onAtMention}
      />
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <audio
            ref={mediaRef}
            key={src}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError(t("files.audioLoadError"))}
            style={{ width: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function VideoViewer({ filePath, cwd, sourceSessionId, watchEnabled = true, onAtMention }: Props) {
  const { t } = useI18n();
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  // A hidden tab or closed panel pauses the watch; stop playback with it.
  useEffect(() => {
    if (!watchEnabled) mediaRef.current?.pause();
  }, [watchEnabled]);
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const syncRequestRef = useRef(0);
  // Version the element last loaded; undefined until the first connect.
  const seenVersionRef = useRef<string | null | undefined>(undefined);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    seenVersionRef.current = undefined;
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);
  }, [filePath, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled) return;

    let active = true;
    const synchronize = (reload: boolean) => {
      const requestId = ++syncRequestRef.current;
      fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
        .then((response) => response.json())
        .then((next: { size?: number; error?: string }) => {
          if (!active || requestId !== syncRequestRef.current) return;
          if (next.error) {
            setError(next.error);
            return;
          }
          if (typeof next.size === "number") setSize(next.size);
          setDuration(null);
          setError(null);
          if (reload) setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (active && requestId === syncRequestRef.current) setError(String(nextError));
        });
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", (event) => {
      setWatching(true);
      // The first connect only refreshes metadata; the element already loaded this file. A reconnect
      // or resumed watch (hidden tab shown again) reloads it only if the file changed meanwhile.
      const version = parseWatchVersion(event);
      const seen = seenVersionRef.current;
      seenVersionRef.current = version;
      synchronize(seen !== undefined && seen !== version);
    });
    es.addEventListener("change", (e) => {
      syncRequestRef.current += 1;
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number; version?: string };
        seenVersionRef.current = d.version ?? null;
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      active = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, sourceSessionId, watchEnabled]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <MediaToolbar
        filePath={filePath}
        cwd={cwd}
        sourceSessionId={sourceSessionId}
        meta={[ext || "video", duration != null && formatDuration(duration), size != null && formatSize(size)]}
        watching={watching}
        onAtMention={onAtMention}
      />
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
          minHeight: 0,
        }}
      >
        <div style={{ width: "min(960px, 100%)", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
          {error && (
            <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <video
            ref={mediaRef}
            key={src}
            controls
            playsInline
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError(t("files.videoLoadError"))}
            style={{ maxWidth: "100%", maxHeight: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function DocumentViewer({ filePath, cwd, sourceSessionId, watchEnabled = true, pdfPage, onAtMention }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const syncRequestRef = useRef(0);
  // Version the element last loaded; undefined until the first connect.
  const seenVersionRef = useRef<string | null | undefined>(undefined);

  const ext = getFileExt(filePath);
  const isPdf = ext === "pdf";
  const previewUrl = isPdf
    ? getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined)
      // The browser's built-in PDF viewer honours #page=N, so a link like
      // report.pdf#page=12 opens on the requested page instead of page 1.
      + (pdfPage ? `#page=${pdfPage}` : "")
    : getFileApiUrl(filePath, "preview", sourceSessionId, bust ? { v: bust } : undefined);

  useEffect(() => {
    setBust(0);
    seenVersionRef.current = undefined;
    setSize(null);
    setError(null);
    setWatching(false);

    let active = true;
    const requestId = ++syncRequestRef.current;
    fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
      .then((r) => r.json())
      .then((d: { size?: number; error?: string }) => {
        if (!active || requestId !== syncRequestRef.current) return;
        if (d.error) setError(d.error);
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError("DOCX too large for preview (>10MB)");
          }
        }
      })
      .catch((nextError) => {
        if (active && requestId === syncRequestRef.current) setError(String(nextError));
      });

    return () => {
      active = false;
    };
  }, [filePath, isPdf, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled) return;

    let active = true;
    const synchronize = (reload: boolean) => {
      const requestId = ++syncRequestRef.current;
      fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
        .then((r) => r.json())
        .then((d: { size?: number; error?: string }) => {
          if (!active || requestId !== syncRequestRef.current) return;
          if (d.error) {
            setError(d.error);
            return;
          }
          if (typeof d.size === "number") {
            setSize(d.size);
            if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
              setError("DOCX too large for preview (>10MB)");
              return;
            }
          }
          setError(null);
          if (reload) setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (active && requestId === syncRequestRef.current) setError(String(nextError));
        });
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", (event) => {
      setWatching(true);
      // The first connect only refreshes metadata; the element already loaded this file. A reconnect
      // or resumed watch (hidden tab shown again) reloads it only if the file changed meanwhile.
      const version = parseWatchVersion(event);
      const seen = seenVersionRef.current;
      seenVersionRef.current = version;
      synchronize(seen !== undefined && seen !== version);
    });
    es.addEventListener("change", (e) => {
      syncRequestRef.current += 1;
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number; version?: string };
        seenVersionRef.current = d.version ?? null;
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError("DOCX too large for preview (>10MB)");
            return;
          }
        }
      } catch { /* ignore */ }
      setError(null);
      setBust((b) => b + 1);
    });
    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      active = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, isPdf, sourceSessionId, watchEnabled]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <MediaToolbar
        filePath={filePath}
        cwd={cwd}
        sourceSessionId={sourceSessionId}
        meta={[ext === "docx" ? "docx preview" : "pdf", size != null && formatSize(size)]}
        watching={watching}
        onAtMention={onAtMention}
      />
      <div style={{ flex: 1, minHeight: 0, background: "var(--bg-panel)" }}>
        {error ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "var(--danger)", fontSize: 12, textAlign: "center" }}>
            {error}
          </div>
        ) : (
          <iframe
            key={previewUrl}
            src={previewUrl}
            sandbox={isPdf ? undefined : "allow-same-origin"}
            title={t("i18n.previewFile", { file: getFileName(filePath) })}
            style={{ width: "100%", height: "100%", border: "none", background: isPdf ? "var(--bg)" : "#eef1f5" }}
          />
        )}
      </div>
    </div>
  );
}

export function FileViewer({
  filePath,
  cwd,
  sourceSessionId,
  onOpenFile,
  onAttachSelection,
  reveal,
  onRevealed,
  onAtMention,
  gitRefreshKey,
  initialDisplayMode,
  initialState,
  onStateChange,
  watchEnabled = true,
  pdfPage,
}: Props) {
  // A mounted viewer reports its state back as `initialState`; read it once so the echo never reloads or re-lays out.
  const [mountState] = useState(initialState);
  const diffRequested = resolveFileDisplayMode(filePath, mountState, initialDisplayMode) === "diff";
  if (!diffRequested && isImagePath(filePath)) {
    return <ImageViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} watchEnabled={watchEnabled} onAtMention={onAtMention} />;
  }
  if (!diffRequested && isAudioPath(filePath)) {
    return <AudioViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} watchEnabled={watchEnabled} onAtMention={onAtMention} />;
  }
  if (!diffRequested && isVideoPath(filePath)) {
    return <VideoViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} watchEnabled={watchEnabled} onAtMention={onAtMention} />;
  }
  if (!diffRequested && isDocumentPreviewPath(filePath)) {
    return <DocumentViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} watchEnabled={watchEnabled} pdfPage={pdfPage} onAtMention={onAtMention} />;
  }
  return (
    <TextFileViewer
      filePath={filePath}
      cwd={cwd}
      sourceSessionId={sourceSessionId}
      onOpenFile={onOpenFile}
      onAttachSelection={onAttachSelection}
      reveal={reveal}
      onRevealed={onRevealed}
      onAtMention={onAtMention}
      gitRefreshKey={gitRefreshKey}
      initialDisplayMode={initialDisplayMode}
      initialState={mountState}
      onStateChange={onStateChange}
      watchEnabled={watchEnabled}
    />
  );
}

const MarkdownFilePreview = memo(function MarkdownFilePreview({
  markdownPreview,
  frontmatterData,
  markdownDirectory,
  onOpenFile,
  sourceSessionId,
}: {
  markdownPreview: string;
  frontmatterData: ReturnType<typeof parseFrontmatter>["data"];
  markdownDirectory: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  sourceSessionId?: string | null;
}) {
  const { t } = useI18n();
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<{ items: { src: string; alt: string }[]; index: number } | null>(null);
  const openZoom = (image: HTMLImageElement) => {
    const root = previewRef.current;
    if (!root) return;
    const images = [...root.querySelectorAll("img")].filter((item) => !item.closest("a, button"));
    setZoom({ items: images.map((item) => ({ src: item.currentSrc || item.src, alt: item.alt })), index: images.indexOf(image) });
  };
  // Only plain images get delegated zoom; links and image components handle themselves.
  useEffect(() => {
    for (const image of previewRef.current?.querySelectorAll("img") ?? []) {
      if (image.closest("a, button")) continue;
      image.tabIndex = 0;
      image.setAttribute("role", "button");
      image.setAttribute("aria-label", image.alt ? `${t("chat.previewImage")}: ${image.alt}` : t("chat.previewImage"));
    }
  }, [markdownPreview, t]);
  return (
    <>
      {zoom && (
        <ImageLightbox
          items={zoom.items}
          index={zoom.index}
          onIndexChange={(index) => setZoom((current) => current && { ...current, index })}
          onClose={() => setZoom(null)}
        />
      )}
      <div
        ref={previewRef}
        className="markdown-body markdown-file-preview"
        style={{ padding: "24px 32px" }}
        // One delegated handler opens plain images in the zoom viewer, with their siblings.
        onClick={(event) => {
          const image = event.target instanceof Element ? event.target.closest("img") : null;
          if (image && !image.closest("a, button")) openZoom(image);
        }}
        onKeyDown={(event) => {
          if ((event.key !== "Enter" && event.key !== " ") || !(event.target instanceof HTMLImageElement) || event.target.closest("a, button")) return;
          event.preventDefault();
          openZoom(event.target);
        }}
      >
        {frontmatterData && <FrontmatterCard data={frontmatterData} />}
        <ReactMarkdown
          remarkPlugins={markdownPreviewRemarkPlugins}
          rehypePlugins={markdownPreviewRehypePlugins}
          urlTransform={onOpenFile ? markdownUrlTransform : markdownAppUrlTransform}
          components={{
            code({ className, children, ...props }) {
              const lang = className?.replace("language-", "").toLowerCase() ?? "";
              const raw = String(children);
              const isBlock = className?.includes("language-") || raw.includes("\n");
              if (isBlock) {
                if (lang === "mermaid") {
                  return <MermaidBlock code={raw.replace(/\n$/, "")} defaultPreview />;
                }
                if (lang === "svg") return <SvgBlock code={raw.replace(/\n$/, "")} />;
                return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
              }
              return (
                <code className={["markdown-inline-code", className].filter(Boolean).join(" ")} {...props}>
                  {children}
                </code>
              );
            },
            table({ children, node }) {
              const start = node?.position?.start.offset;
              const end = node?.position?.end.offset;
              return (
                <MarkdownTableBlock getSource={start !== undefined && end !== undefined ? () => tableSource(markdownPreview, start, end) : undefined}>
                  {children}
                </MarkdownTableBlock>
              );
            },
            pre({ children }) {
              // Render the code block directly — CodeBlock provides its own wrapping.
              // For non-mermaid blocks, pass through to default pre rendering.
              return <>{children}</>;
            },
            a({ href, children, ...props }) {
              delete props.node;
              if (href?.startsWith("#")) {
                // In-document anchor (e.g. a TOC): scroll inside the preview instead of opening a tab.
                const handleAnchorClick = (event: MouseEvent<HTMLAnchorElement>) => {
                  event.preventDefault();
                  const slug = decodeURIComponent(href.slice(1));
                  const root = event.currentTarget.closest(".markdown-file-preview");
                  const headings = [...(root?.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? [])];
                  const target = root?.querySelector<HTMLElement>(`[id="user-content-${CSS.escape(slug)}"]`)
                    ?? headings[findHeadingBySlug(headings.map((el) => el.textContent ?? ""), slug)];
                  target?.scrollIntoView({ block: "start", inline: "nearest" });
                };
                return <a href={href} {...props} onClick={handleAnchorClick}>{children}</a>;
              }
              const linkedFile = onOpenFile
                ? resolveLocalFileHref(href, markdownDirectory)
                : null;
              if (!linkedFile || !onOpenFile) {
                return <a href={href} {...props} target="_blank" rel="noopener noreferrer">{children}</a>;
              }

              const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
                if (!shouldOpenLocalFileInApp(event)) return;
                event.preventDefault();
                onOpenFile(linkedFile, pdfPageFromHref(href) ?? undefined);
              };

              return <a href={href} {...props} onClick={handleClick}>{children}</a>;
            },
            img({ src, alt, ...props }) {
              delete props.node;
              const imagePath = typeof src === "string"
                ? resolveLocalFileHref(src, markdownDirectory)
                : null;
              const imageSrc = imagePath
                ? getFileApiUrl(imagePath, "read", sourceSessionId)
                : src;
              const mediaPath = imagePath ?? (typeof src === "string" ? src.split(/[?#]/, 1)[0] : "");
              if (isAudioPath(mediaPath) || isVideoPath(mediaPath)) {
                return <MarkdownMedia src={typeof imageSrc === "string" ? imageSrc : undefined} alt={alt} video={isVideoPath(mediaPath)} />;
              }
              // Dynamic local paths are served directly by the file API.
              // eslint-disable-next-line @next/next/no-img-element
              return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
            },
          }}
        >
          {markdownPreview}
        </ReactMarkdown>
      </div>
    </>
  );
});

function TextFileViewer({
  filePath,
  cwd,
  sourceSessionId,
  onOpenFile,
  onAttachSelection,
  reveal,
  onRevealed,
  onAtMention,
  gitRefreshKey,
  initialDisplayMode,
  initialState,
  onStateChange,
  watchEnabled = true,
}: Props) {
  const { isDark, palette } = useTheme();
  const { t } = useI18n();
  const confirm = useConfirm();
  const [data, setData] = useState<FileData | null>(null);
  const [gitDiff, setGitDiff] = useState<GitFileDiffResponse | null>(null);
  const [gitDiffLoading, setGitDiffLoading] = useState(false);
  const [gitDiffResolved, setGitDiffResolved] = useState(false);
  const [gitDiffError, setGitDiffError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestedInitialDisplayMode = resolveFileDisplayMode(filePath, initialState, initialDisplayMode);
  const skipContentLoad = requestedInitialDisplayMode === "diff" && (
    isImagePath(filePath)
    || isAudioPath(filePath)
    || isVideoPath(filePath)
    || isDocumentPreviewPath(filePath)
  );
  const initialWrapLines = initialState?.wrapLines ?? false;
  const initialModeScroll = initialState?.scrollByMode?.[requestedInitialDisplayMode];
  const initialScrollTop = initialModeScroll?.scrollTop ?? initialState?.scrollTop ?? 0;
  const initialScrollLeft = initialModeScroll?.scrollLeft ?? initialState?.scrollLeft ?? 0;
  const initialLoadedBytes = initialState?.loadedBytes ?? 0;
  // Nothing to restore: skip offscreen layout from the first frame (halves a large first open).
  const offscreenSkipFromStart = initialScrollTop === 0 && initialScrollLeft === 0;
  const [displayMode, setDisplayMode] = useState<DisplayMode>(requestedInitialDisplayMode);
  const [wrapLines, setWrapLines] = useState(initialWrapLines);
  const [watching, setWatching] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const contentRequestRef = useRef(0);
  const contentVersionRef = useRef<string | null>(null);
  const contentNextOffsetRef = useRef(0);
  const initialContentLoadRef = useRef<Promise<FileData | null> | null>(null);
  const watchConnectedRef = useRef(false);
  const gitDiffRequestRef = useRef(0);
  const diffRequestedRef = useRef(false);
  const diffStaleRef = useRef(false);
  const watchEnabledRef = useRef(watchEnabled);
  watchEnabledRef.current = watchEnabled;
  const contentRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const autoDiffAppliedRef = useRef(false);
  const scrollRestorePendingRef = useRef(true);
  const viewerStateRef = useRef<FileViewerState>({
    displayMode: requestedInitialDisplayMode,
    wrapLines: initialWrapLines,
    scrollTop: initialScrollTop,
    scrollLeft: initialScrollLeft,
    loadedBytes: initialLoadedBytes,
    scrollByMode: { ...initialState?.scrollByMode },
  });
  const onStateChangeRef = useRef(onStateChange);
  const [selectionAttachment, setSelectionAttachment] = useState<FileSelectionAttachment | null>(null);
  const [attachAnchor, setAttachAnchor] = useState<SelectionAnchor | null>(null);
  const attachToolbarRef = useRef<HTMLDivElement | null>(null);
  // Whole file for an HTML preview whose source view is still chunked.
  const [htmlFull, setHtmlFull] = useState<{ text?: string; error?: string } | null>(null);

  onStateChangeRef.current = onStateChange;
  // A stable identity keeps the memoized markdown preview from re-parsing when the shell's callback changes.
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const openFile = useCallback((path: string, page?: number) => onOpenFileRef.current?.(path, page), []);

  const updateDisplayMode = useCallback((nextDisplayMode: DisplayMode) => {
    viewerStateRef.current.displayMode = nextDisplayMode;
    setDisplayMode(nextDisplayMode);
  }, []);

  const toggleWrapLines = useCallback(() => {
    setWrapLines((current) => {
      const next = !current;
      viewerStateRef.current.wrapLines = next;
      return next;
    });
  }, []);

  // AppShell keys this viewer by tab id + viewerRevision, so every intended reset
  // remounts it and the initializers above apply. Save on unmount only: reacting to
  // `initialState` would re-read our own saved echo (new scrollByMode identity each
  // time) and loop under StrictMode's mount/unmount/mount.
  // A hidden (cached) or closed viewer reports too, so a reopen that remounts it starts from current state.
  useEffect(() => {
    if (watchEnabled) return;
    onStateChangeRef.current?.({ ...viewerStateRef.current });
    // A hidden (cached) Markdown preview must not keep playing its inline media, like AudioViewer/VideoViewer.
    shellRef.current?.querySelectorAll<HTMLMediaElement>("audio, video").forEach((media) => media.pause());
  }, [watchEnabled]);

  useEffect(() => {
    // A reload never unmounts, so report on pagehide too; the shell persists tabs from it.
    const report = () => onStateChangeRef.current?.({ ...viewerStateRef.current });
    window.addEventListener("pagehide", report);
    return () => {
      window.removeEventListener("pagehide", report);
      report();
    };
  }, []);

  // Read chunks from `startOffset` (appending to the shown content) or from 0 (replacing it) until
  // `minBytes`, then publish once: a half-read refresh would drop a large markdown file back to
  // Source and render it twice. A newer request supersedes this one (returns null).
  const readContent = useCallback(async (filePath: string, startOffset: number, minBytes: number) => {
    const requestId = ++contentRequestRef.current;
    const readAt = async (nextOffset: number) => {
      const response = await fetch(getFileApiUrl(filePath, "read", sourceSessionId, { offset: nextOffset || undefined }));
      return response.json() as Promise<FileData>;
    };

    try {
      const result = await readTextChunks(readAt, {
        // Appending is only valid onto the exact offset on screen.
        startOffset: startOffset === contentNextOffsetRef.current ? startOffset : 0,
        version: contentVersionRef.current,
        minBytes,
        isCurrent: () => requestId === contentRequestRef.current,
      });
      if (result.kind === "superseded") return null;
      if (result.kind === "error") {
        setError(result.error);
        return null;
      }
      const { append, chunk } = result;
      setError(null);
      contentVersionRef.current = chunk.version;
      contentNextOffsetRef.current = chunk.nextOffset;
      viewerStateRef.current.loadedBytes = chunk.nextOffset;
      setData((current) => append && current ? { ...chunk, content: current.content + chunk.content } : chunk);
      return chunk;
    } catch (nextError) {
      if (requestId !== contentRequestRef.current) return null;
      setError(String(nextError));
      return null;
    }
  }, [sourceSessionId]);

  // Reload from the start up to `minBytes`.
  const loadContent = useCallback(
    (filePath: string, minBytes: number) => readContent(filePath, 0, minBytes),
    [readContent],
  );
  // Continue from the current offset to the end.
  const loadRest = useCallback(
    (filePath: string, offset: number) => readContent(filePath, offset, Number.POSITIVE_INFINITY),
    [readContent],
  );
  // Markdown/HTML preview needs the whole document, so read those in full up to a cap.
  const autoLoadBytes = isFilePreviewPath(filePath) ? PREVIEW_AUTOLOAD_MAX_BYTES : 0;

  const fetchGitDiff = useCallback(async (targetPath: string) => {
    const requestId = ++gitDiffRequestRef.current;
    setGitDiffLoading(true);
    setGitDiffError(null);
    if (!cwd) {
      setGitDiff(null);
      setGitDiffLoading(false);
      setGitDiffResolved(true);
      return;
    }

    try {
      const params = new URLSearchParams({ cwd, path: targetPath });
      const response = await fetch(`/api/git/diff?${params.toString()}`);
      const next = await response.json() as GitFileDiffResponse & { error?: string };
      if (requestId !== gitDiffRequestRef.current) return;
      // A failed refresh keeps the last diff; only a successful answer replaces or clears it.
      if (!response.ok) setGitDiffError(next.error ?? `Failed to load diff (HTTP ${response.status})`);
      else setGitDiff(next.supported && typeof next.patch === "string" ? next : null);
    } catch (error) {
      if (requestId === gitDiffRequestRef.current) {
        setGitDiffError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === gitDiffRequestRef.current) {
        setGitDiffLoading(false);
        setGitDiffResolved(true);
      }
    }
  }, [cwd]);

  // Reset and load the file itself when its identity changes. Live watching is
  // managed separately so pausing it never clears the displayed content.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setData(null);
    setGitDiff(null);
    setGitDiffResolved(false);
    setGitDiffError(null);
    setWatching(false);
    contentVersionRef.current = null;
    contentNextOffsetRef.current = 0;
    watchConnectedRef.current = false;

    if (skipContentLoad) {
      setLoading(false);
      initialContentLoadRef.current = null;
      return () => {
        active = false;
        contentRequestRef.current += 1;
      };
    }

    const initialLoad = loadContent(filePath, Math.max(initialLoadedBytes, autoLoadBytes));
    initialContentLoadRef.current = initialLoad;
    initialLoad.finally(() => {
      if (initialContentLoadRef.current === initialLoad) {
        initialContentLoadRef.current = null;
      }
      if (active) setLoading(false);
    });

    return () => {
      active = false;
      contentRequestRef.current += 1;
    };
  }, [autoLoadBytes, filePath, loadContent, initialLoadedBytes, skipContentLoad, sourceSessionId]);

  useEffect(() => {
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!watchEnabled) return;

    // A save often arrives as several change events; reload once they settle.
    let changeTimer: ReturnType<typeof setTimeout> | null = null;
    const synchronize = () => {
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        changeTimer = null;
        if (!skipContentLoad) void loadContent(filePath, Math.max(viewerStateRef.current.loadedBytes ?? 0, autoLoadBytes));
        void fetchGitDiff(filePath);
      }, WATCH_CHANGE_DEBOUNCE_MS);
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", (event) => {
      setWatching(true);
      const reconnecting = watchConnectedRef.current;
      watchConnectedRef.current = true;
      if (reconnecting || diffStaleRef.current) {
        diffStaleRef.current = false;
        void fetchGitDiff(filePath);
      }
      if (skipContentLoad) return;
      const connectedVersion = (() => {
        try {
          return (JSON.parse((event as MessageEvent).data) as { version?: string | null }).version ?? null;
        } catch {
          return null;
        }
      })();
      void (initialContentLoadRef.current ?? Promise.resolve()).then(() => {
        if (esRef.current !== es || connectedVersion === contentVersionRef.current) return;
        void loadContent(filePath, Math.max(viewerStateRef.current.loadedBytes ?? 0, autoLoadBytes));
        void fetchGitDiff(filePath);
      });
    });

    es.addEventListener("change", synchronize);

    const markDisconnected = () => {
      setWatching(false);
    };
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      if (changeTimer) clearTimeout(changeTimer);
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [autoLoadBytes, filePath, fetchGitDiff, loadContent, skipContentLoad, sourceSessionId, watchEnabled]);

  // A paused viewer (hidden tab, closed panel) skips refresh bumps; resuming the watch refetches the diff.
  useEffect(() => {
    if (diffRequestedRef.current && !watchEnabledRef.current) {
      diffStaleRef.current = true;
      return;
    }
    diffRequestedRef.current = true;
    void fetchGitDiff(filePath);
  }, [fetchGitDiff, filePath, gitRefreshKey]);

  // A half HTML document cannot render, so a chunked one previews from one
  // whole-file fetch. A new file version (watch change) refetches it while the
  // previous page stays up, so a live change does not flash "Loading"; more
  // chunks of the same version do not.
  const needsHtmlFull = displayMode === "preview"
    && data?.language === "html"
    && data.truncated
    && data.size <= HTML_PREVIEW_MAX_BYTES;
  useEffect(() => {
    if (!needsHtmlFull) {
      setHtmlFull(null);
      return;
    }
    const controller = new AbortController();
    fetch(getFileApiUrl(filePath, "download", sourceSessionId), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (!controller.signal.aborted) setHtmlFull({ text });
      })
      .catch((fetchError) => {
        if (!controller.signal.aborted) setHtmlFull({ error: String(fetchError) });
      });
    return () => controller.abort();
  }, [needsHtmlFull, data?.version, filePath, sourceSessionId]);

  const hasGitDiff = gitDiff?.supported === true && typeof gitDiff.patch === "string";
  const isDeletedDiff = hasGitDiff && gitDiff.status === "deleted";

  useEffect(() => {
    if (gitDiffResolved && !hasGitDiff && displayMode === "diff") updateDisplayMode("source");
  }, [displayMode, gitDiffResolved, hasGitDiff, updateDisplayMode]);

  // Wait for the git request before restoring diff mode so the unresolved
  // placeholder cannot immediately demote it back to source.
  useEffect(() => {
    if (requestedInitialDisplayMode === "diff" && hasGitDiff && !autoDiffAppliedRef.current) {
      autoDiffAppliedRef.current = true;
      updateDisplayMode("diff");
    }
  }, [requestedInitialDisplayMode, hasGitDiff, updateDisplayMode]);

  const markdownPreview = useMemo(
    () => (data?.language === "markdown" ? normalizeDisplayMath(data.content) : ""),
    [data],
  );

  const frontmatter = useMemo(
    () => (data?.language === "markdown" ? parseFrontmatter(data.content) : null),
    [data],
  );
  const outlineItems = useMemo(
    () => extractMarkdownOutline(frontmatter?.rest ?? ""),
    [frontmatter],
  );

  const viewerContent = data?.content ?? "";
  const sourceLines = useMemo(() => viewerContent.split("\n"), [viewerContent]);
  const language = data?.language ?? "text";
  // Plain text needs no Prism languages; any other file loads them once.
  const prismReady = usePrismLanguages(Boolean(data) && language !== "text");
  const isHtml = language === "html";
  const isMarkdown = language === "markdown";
  // A CSV/TSV table shows a loaded prefix too; its cut last record waits for "Load more".
  const isDelimitedTable = isDelimitedTablePath(filePath);
  const hasPreview = isDelimitedTable || (isHtml
    ? !!data && (!data.truncated || data.size <= HTML_PREVIEW_MAX_BYTES)
    : isMarkdown && !data?.truncated);
  const effectiveDisplayMode = isDeletedDiff
    ? "diff"
    : displayMode === "preview" && !hasPreview
      ? "source"
      : displayMode;
  // A fresh token whenever the rendered text may change, so an open find bar searches again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const findContentKey = useMemo(() => ({}), [data, gitDiff, htmlFull, effectiveDisplayMode, wrapLines]);
  const useLightweightSource = (
    sourceLines.length > SOURCE_HIGHLIGHT_MAX_LINES
    || (data?.size ?? 0) > SOURCE_HIGHLIGHT_MAX_BYTES
  )
    && !(effectiveDisplayMode === "diff" && hasGitDiff)
    && !(effectiveDisplayMode === "preview" && hasPreview);
  const showHighlightedSource = !useLightweightSource
    && !(effectiveDisplayMode === "diff" && hasGitDiff)
    && !(effectiveDisplayMode === "preview" && hasPreview);
  // react-syntax-highlighter rebuilds every token element on each render, which
  // costs hundreds of milliseconds on large files. Cache the rendered trees so
  // unrelated re-renders (panel open/close, selection changes) reuse them as-is.
  // Skip the tree entirely in preview/diff so opening a markdown file does not
  // highlight source that will never be painted.
  const highlightedSource = useMemo(
    () => showHighlightedSource ? (
      <SyntaxHighlighter
        className={wrapLines ? "file-source-view is-wrapped" : "file-source-view"}
        language={language === "text" || !prismReady ? "plaintext" : language}
        style={palette === "claude" ? (isDark ? claudeDarkCodeStyle : claudeCodeStyle) : isDark ? vscDarkPlus : vs}
        showLineNumbers
        lineNumberStyle={FILE_PINNED_LINE_NUMBER_STYLE}
        customStyle={{
          margin: 0,
          padding: 0,
          border: 0,
          background: "var(--bg)",
          ...FILE_CODE_STYLE,
          width: wrapLines ? "100%" : "max-content",
          minWidth: "100%",
          minHeight: "100%",
          overflow: "visible",
        }}
        codeTagProps={{
          style: {
            fontFamily: "var(--font-mono)",
            overflowWrap: wrapLines ? "anywhere" : "normal",
          },
        }}
        renderer={(rendererProps) => (
          <SourceCodeRenderer {...rendererProps} wrapLines={wrapLines} />
        )}
        wrapLongLines={wrapLines}
      >
        {viewerContent}
      </SyntaxHighlighter>
    ) : null,
    [isDark, language, palette, prismReady, showHighlightedSource, viewerContent, wrapLines],
  );
  const lightweightSourceLines = useMemo(
    () => useLightweightSource ? chunkSourceLines(sourceLines.map((line, lineIndex) => (
      <span
        className="file-source-line"
        data-line-number={lineIndex + 1}
        key={`source-line-${lineIndex}`}
        style={{ display: "flex", minWidth: "100%" }}
      >
        <span aria-hidden="true" style={FILE_LINE_NUMBER_STYLE}>
          {lineIndex + 1}
        </span>
        <span
          className="file-source-line-content"
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflowWrap: wrapLines ? "anywhere" : "normal",
            whiteSpace: wrapLines ? "pre-wrap" : "pre",
          }}
        >
          {line}
        </span>
      </span>
    ))) : null,
    [sourceLines, useLightweightSource, wrapLines],
  );

  // What the current selection would attach: whole source lines, or the selected markdown preview text.
  const readSelectionAttachment = useCallback((): FileSelectionAttachment | null => {
    const root = contentRef.current;
    const selection = window.getSelection();
    if (!onAttachSelection || !root || !selection || selection.isCollapsed || !selection.rangeCount) return null;
    const relativePath = getRelativeFilePath(filePath, cwd);
    if (effectiveDisplayMode === "source") {
      const lineRange = getSelectedSourceLineRange(root, selection);
      if (!lineRange) return null;
      const text = sourceLines.slice(lineRange.startLine - 1, lineRange.endLine).join("\n");
      return text.trim() ? { relativePath, sourceCwd: cwd, text, ...lineRange } : null;
    }
    if (!isMarkdown || effectiveDisplayMode !== "preview" || !root.contains(selection.getRangeAt(0).commonAncestorContainer)) return null;
    const text = selectedTextWithTex(selection.getRangeAt(0));
    return text ? { relativePath, sourceCwd: cwd, text } : null;
  }, [cwd, effectiveDisplayMode, filePath, isMarkdown, onAttachSelection, sourceLines]);

  useEffect(() => {
    const update = () => {
      const next = readSelectionAttachment();
      // selectionchange fires continuously while dragging; skip equal results so the viewer does not re-render.
      setSelectionAttachment((current) => sameAttachment(current, next) ? current : next);
      if (!next) setAttachAnchor(null);
    };
    update();
    if (!onAttachSelection) return;
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [readSelectionAttachment, onAttachSelection]);

  const attachSelection = useCallback((attachment: FileSelectionAttachment | null) => {
    if (!onAttachSelection || !attachment) return;
    onAttachSelection(attachment);
    setAttachAnchor(null);
    window.getSelection()?.removeAllRanges();
  }, [onAttachSelection]);

  // The floating "Quote" button appears once a selection gesture ends, placed like the
  // chat's selection toolbar (lib/selection-toolbar.ts).
  const showAttachButton = useCallback(() => {
    const selection = window.getSelection();
    if (!readSelectionAttachment() || !selection?.rangeCount) return;
    setAttachAnchor(selectionAnchor(selection.getRangeAt(0)));
  }, [readSelectionAttachment]);

  useLayoutEffect(() => {
    const toolbar = attachToolbarRef.current;
    if (!toolbar || !attachAnchor) return;
    const content = contentRef.current?.getBoundingClientRect() ?? null;
    const placed = placeSelectionToolbar(attachAnchor, toolbar.getBoundingClientRect(), visibleBounds(content), { preferBelow: prefersToolbarBelow() });
    toolbar.style.top = `${placed.top}px`;
    toolbar.style.left = `${placed.left}px`;
  }, [attachAnchor, selectionAttachment]);

  useEffect(() => {
    if (!onAttachSelection) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.key.toLowerCase() !== "i" || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;

      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;

      const attachment = readSelectionAttachment();
      if (!attachment) return;

      event.preventDefault();
      attachSelection(attachment);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [attachSelection, onAttachSelection, readSelectionAttachment]);

  const revealHighlightTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!reveal || !data) return;
    // Text came from the markdown preview, lines from the source view: show the view it came from.
    const wantedMode = "text" in reveal ? (isMarkdown && hasPreview ? "preview" : effectiveDisplayMode) : "source";
    if (effectiveDisplayMode !== wantedMode) {
      updateDisplayMode(wantedMode);
      return;
    }
    const root = contentRef.current;
    const ranges: Range[] = [];
    if (root && "text" in reveal) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const found = findQuoteInSegments(nodes.map((node) => node.data), reveal.text);
      if (found) {
        const range = document.createRange();
        range.setStart(nodes[found.start[0]], found.start[1]);
        range.setEnd(nodes[found.end[0]], found.end[1]);
        ranges.push(range);
      }
    } else if (root && "start" in reveal) {
      const lineElement = (line: number) => root.querySelector<HTMLElement>(`.file-source-line[data-line-number="${line}"] .file-source-line-content`)
        ?? root.querySelector<HTMLElement>(`.file-source-line[data-line-number="${line}"]`);
      // One range per line, so the line-number gutter between them stays unmarked.
      // shortcut: lines past a partially loaded file are not revealed; load more first if this matters.
      for (let line = reveal.start; line <= reveal.end; line++) {
        const element = lineElement(line);
        if (!element) break;
        const range = document.createRange();
        range.selectNodeContents(element);
        ranges.push(range);
      }
    }
    if (root && ranges.length) {
      // Offscreen blocks only have estimated heights (content-visibility) until laid out,
      // so re-aim once the scroll has made them real.
      const aim = () => scrollIntoScroller(root, ranges[0]);
      aim();
      requestAnimationFrame(() => { aim(); requestAnimationFrame(aim); });
      if (typeof Highlight !== "undefined") {
        CSS.highlights.set("quote-source", new Highlight(...ranges));
        if (revealHighlightTimerRef.current !== null) window.clearTimeout(revealHighlightTimerRef.current);
        revealHighlightTimerRef.current = window.setTimeout(() => CSS.highlights.delete("quote-source"), 2000);
      }
    }
    onRevealed?.();
  }, [data, effectiveDisplayMode, hasPreview, highlightedSource, isMarkdown, lightweightSourceLines, markdownPreview, onRevealed, reveal, updateDisplayMode]);

  // Cmd/Ctrl+F opens the in-file find once the viewer was last clicked or holds focus;
  // anywhere else the browser's own find stays.
  useEffect(() => {
    let engaged = false;
    const handlePointerDown = (event: PointerEvent) => {
      engaged = event.target instanceof Node && Boolean(shellRef.current?.contains(event.target));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const shell = shellRef.current;
      if (!shell || shell.closest("[inert]")) return;
      if (!engaged && !shell.contains(document.activeElement)) return;
      event.preventDefault();
      setFindOpen(true);
      // Already open: refocus the field.
      shell.querySelector<HTMLInputElement>(".file-find-bar input")?.select();
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!scrollRestorePendingRef.current || loading) return;
    if (error && !isDeletedDiff) return;
    if (requestedInitialDisplayMode === "diff" && !gitDiffResolved) return;
    if (requestedInitialDisplayMode === "diff" && hasGitDiff && displayMode !== "diff") return;

    const content = contentRef.current;
    if (!content) return;

    content.scrollTop = viewerStateRef.current.scrollTop;
    content.scrollLeft = viewerStateRef.current.scrollLeft;
    scrollRestorePendingRef.current = false;
    // With a position to restore, offscreen skipping (content-visibility) starts only after one full
    // layout, so every block has a remembered real size; earlier would restore against estimated heights.
    requestAnimationFrame(() => requestAnimationFrame(() => content.classList.add("is-laid-out")));
  }, [
    data?.content,
    displayMode,
    error,
    gitDiffResolved,
    hasGitDiff,
    isDeletedDiff,
    loading,
    requestedInitialDisplayMode,
  ]);

  useLayoutEffect(() => {
    if (scrollRestorePendingRef.current) return;
    const content = contentRef.current;
    if (!content) return;
    const position = viewerStateRef.current.scrollByMode?.[effectiveDisplayMode];
    content.scrollTop = position?.scrollTop ?? 0;
    content.scrollLeft = position?.scrollLeft ?? 0;
  }, [effectiveDisplayMode]);

  if (loading || (requestedInitialDisplayMode === "diff" && gitDiffLoading && !gitDiffResolved)) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12 }}>
        {t("i18n.loading")}
      </div>
    );
  }

  if (requestedInitialDisplayMode === "diff" && gitDiffResolved && gitDiffError && !hasGitDiff) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "var(--danger)", fontSize: 12, textAlign: "center" }}>
        {gitDiffError}
      </div>
    );
  }

  // A failed refresh or Load more keeps the loaded content and shows a retry bar instead.
  if (error && !data && !(effectiveDisplayMode === "diff" && hasGitDiff)) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--danger)", fontSize: 12 }}>
        {error}
        {error === BINARY_FILE_ERROR && (
          <>
            <MentionButton filePath={filePath} cwd={cwd} onAtMention={onAtMention} />
            <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
          </>
        )}
      </div>
    );
  }

  if (!data && !(effectiveDisplayMode === "diff" && hasGitDiff)) return null;

  const content = viewerContent;
  const markdownDirectory = getFileDirectory(filePath);
  const lines = sourceLines;
  const displayModes: DisplayMode[] = !data || isDeletedDiff
    ? ["diff"]
    : [
        "source",
        ...(hasPreview ? ["preview" as const] : []),
        ...(hasGitDiff ? ["diff" as const] : []),
      ];
  // Shown over content that stays usable: a failed content refresh or Load all, or a failed diff refresh.
  const refreshError = (data ? error : null) ?? (hasGitDiff ? gitDiffError : null);
  const metadata = isDeletedDiff
    ? t("files.deleted")
    : data
      ? `${language} · ${lines.length} lines · ${formatSize(data.size)}`
      : t("i18n.diff");

  return (
    <div ref={shellRef} className="file-viewer-shell" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", position: "relative" }}>
      <div
        className="file-viewer-toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 8px 5px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span className="file-viewer-path" title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>

        <span className="file-viewer-meta" title={metadata}>{metadata}</span>
        {data && !isDeletedDiff && (
          <span
            title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
            aria-label={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
            className="file-viewer-live-indicator"
            style={{
              background: watching ? "var(--success)" : "var(--border)",
              boxShadow: watching ? "0 0 4px var(--success)" : "none",
            }}
          />
        )}

        <div className="file-viewer-controls">
          {displayModes.length > 1 && (
            <div className="file-viewer-mode-switch" aria-label={t("i18n.fileViewMode")}>
              {displayModes.map((mode) => {
                const active = effectiveDisplayMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => updateDisplayMode(mode)}
                    title={mode === "diff" ? t("i18n.compareHead") : undefined}
                    aria-pressed={active}
                    className="file-viewer-mode-button"
                    style={{
                      background: active ? "var(--bg-selected)" : "transparent",
                      color: active ? "var(--text)" : "var(--text-muted)",
                    }}
                  >
                    {mode === "source" ? t("i18n.source") : mode === "preview" ? t("i18n.preview") : t("i18n.diff")}
                  </button>
                );
              })}
            </div>
          )}

          <div className="file-viewer-actions">
            <button
              type="button"
              onClick={() => setFindOpen(true)}
              title={`${t("files.find")} (${FIND_SHORTCUT_LABEL})`}
              aria-label={t("files.find")}
              aria-pressed={findOpen}
              className="file-viewer-icon-button"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </button>
            {isMarkdown && effectiveDisplayMode === "preview" && (
              <MarkdownOutlineMenu items={outlineItems} scrollRoot={contentRef} />
            )}
            {(onAtMention || onAttachSelection) && (
              <button
                type="button"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  // Mention selected lines when a range is active (and line
                  // mention is wired up); otherwise fall back to a whole-file
                  // @mention. Same button, behavior follows the selection.
                  if (selectionAttachment) {
                    attachSelection(selectionAttachment);
                  } else {
                    onAtMention?.(getRelativeFilePath(filePath, cwd), false, cwd);
                  }
                }}
                title={
                  selectionAttachment?.startLine
                    ? `${t("i18n.mentionSelectedLines")} (L${selectionAttachment.startLine}${selectionAttachment.startLine !== selectionAttachment.endLine ? `-L${selectionAttachment.endLine}` : ""})`
                    : selectionAttachment ? t("i18n.mentionSelectedLines") : t("files.insertPath")
                }
                aria-label={t("files.mention")}
                disabled={!onAtMention && !onAttachSelection}
                className="file-viewer-icon-button"
              >
                <MentionIcon />
              </button>
            )}
            {effectiveDisplayMode === "source" && (
              <>
                <button
                  type="button"
                  onClick={toggleWrapLines}
                  title={wrapLines ? t("i18n.disableWrap") : t("i18n.enableWrap")}
                  aria-label={wrapLines ? t("i18n.disableWrap") : t("i18n.enableWrap")}
                  aria-pressed={wrapLines}
                  className="file-viewer-icon-button"
                  style={{
                    background: wrapLines ? "var(--bg-selected)" : "transparent",
                    color: wrapLines ? "var(--text)" : "var(--text-muted)",
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 6h18" />
                    <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
                    <path d="m16 16-2 2 2 2" />
                    <path d="M3 18h7" />
                  </svg>
                </button>
              </>
            )}
          </div>

          {!isDeletedDiff && <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />}
        </div>
      </div>

      {findOpen && (
        <div style={{ position: "relative", height: 0, zIndex: 3 }}>
          <FileFindBar
            scrollerRef={contentRef}
            contentKey={findContentKey}
            unsupportedMessage={effectiveDisplayMode === "preview" && (isHtml || isDelimitedTable)
              ? t("files.findSourceOnly")
              : undefined}
            partial={Boolean(data?.truncated)}
            canGoToLine={effectiveDisplayMode === "source"}
            onClose={() => setFindOpen(false)}
          />
        </div>
      )}
      {refreshError ? (
        <div className="file-viewer-load-more" role="alert">
          <span style={{ color: "var(--danger)" }}>{refreshError}</span>
          <button
            type="button"
            className="file-viewer-mode-button"
            onClick={() => {
              if (error) void loadContent(filePath, Math.max(viewerStateRef.current.loadedBytes ?? 0, autoLoadBytes));
              if (gitDiffError) void fetchGitDiff(filePath);
            }}
          >
            {t("i18n.retry")}
          </button>
        </div>
      ) : null}
      {/* A chunked HTML preview shows the whole file, so Load more belongs to Source. */}
      {!refreshError && data?.truncated && !(isHtml && effectiveDisplayMode === "preview") && (
        <div className="file-viewer-load-more">
          <span>{formatSize(data.nextOffset)} / {formatSize(data.size)}</span>
          <button
            type="button"
            className="file-viewer-mode-button"
            disabled={loadingMore}
            onClick={async () => {
              if (data.size > LOAD_ALL_CONFIRM_BYTES && !(await confirm(t("i18n.loadAllConfirm", { size: formatSize(data.size) })))) return;
              setLoadingMore(true);
              void loadRest(filePath, data.nextOffset).finally(() => setLoadingMore(false));
            }}
          >
            {loadingMore ? t("i18n.loading") : t("i18n.loadAll")}
          </button>
        </div>
      )}

      {/* Content area */}
      <div
        ref={contentRef}
        className={offscreenSkipFromStart ? "file-viewer-content is-laid-out" : "file-viewer-content"}
        onPointerUp={showAttachButton}
        onKeyUp={(event) => { if (event.shiftKey) showAttachButton(); }}
        onScroll={(event) => {
          setAttachAnchor(null);
          const position = {
            scrollTop: event.currentTarget.scrollTop,
            scrollLeft: event.currentTarget.scrollLeft,
          };
          viewerStateRef.current.scrollTop = position.scrollTop;
          viewerStateRef.current.scrollLeft = position.scrollLeft;
          viewerStateRef.current.scrollByMode = {
            ...viewerStateRef.current.scrollByMode,
            [effectiveDisplayMode]: position,
          };
        }}
        style={{ flex: 1, overflow: "auto", background: "var(--bg)", paddingBottom: data?.truncated && !(isHtml && effectiveDisplayMode === "preview") ? 48 : undefined }}
      >
        {effectiveDisplayMode === "diff" && hasGitDiff ? (
          <DiffView patch={gitDiff.patch!} />
        ) : isHtml && effectiveDisplayMode === "preview" && data?.truncated && !htmlFull?.text ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: htmlFull?.error ? "var(--danger)" : "var(--text-muted)", fontSize: 12, textAlign: "center" }}>
            {htmlFull?.error ?? t("i18n.loading")}
          </div>
        ) : isHtml && effectiveDisplayMode === "preview" ? (
          <iframe
            srcDoc={data?.truncated ? htmlFull?.text : content}
            sandbox="allow-scripts"
            style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
             title={t("i18n.htmlPreview")}
          />
        ) : isMarkdown && effectiveDisplayMode === "preview" ? (
          <MarkdownFilePreview
            markdownPreview={markdownPreview}
            frontmatterData={frontmatter?.data ?? null}
            markdownDirectory={markdownDirectory}
            onOpenFile={onOpenFile ? openFile : undefined}
            sourceSessionId={sourceSessionId}
          />
        ) : isDelimitedTable && effectiveDisplayMode === "preview" ? (
          <DelimitedTable
            content={content}
            filePath={filePath}
            complete={!data?.truncated}
            scrollRef={contentRef}
          />
        ) : useLightweightSource ? (
          <div
            className={wrapLines ? "file-source-view is-lightweight is-wrapped" : "file-source-view is-lightweight"}
            style={{
              width: wrapLines ? "100%" : "max-content",
              minWidth: "100%",
              minHeight: "100%",
              background: "var(--bg)",
              ...FILE_CODE_STYLE,
            }}
          >
            {lightweightSourceLines}
          </div>
        ) : (
          highlightedSource
        )}
      </div>
      {attachAnchor && selectionAttachment && createPortal(
        <div ref={attachToolbarRef} role="toolbar" aria-label={t("i18n.mentionSelectedLines")} className="popover-surface" style={{ position: "fixed", top: 0, left: 0, zIndex: 130, padding: 2 }}>
          <button
            type="button"
            className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-[4px] border-0 bg-transparent px-2 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => attachSelection(selectionAttachment)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 4v16M4 12h16" /></svg>
            <span>{t("chat.askInCurrent")}</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
