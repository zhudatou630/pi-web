"use client";

import { useState } from "react";
import { ImagePreview } from "./ImagePreview";
import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi, joinFilePath } from "@/lib/file-paths";
import { getImageGenerationResult, type ImageGenerationResult } from "@/lib/image-generation";

function fileUrl(filePath: string, type: "read" | "download"): string {
  return `/api/files/${encodeFilePathForApi(filePath)}?type=${type}`;
}

function absoluteImagePath(path: string, cwd?: string): string {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) ? path : cwd ? joinFilePath(cwd, path) : path;
}

export function ImageMentionChip({ path, cwd, onRemove }: {
  path: string;
  cwd?: string;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const src = fileUrl(absoluteImagePath(path, cwd), "read");
  return (
    <span className="relative inline-block shrink-0 overflow-hidden rounded-md border border-border align-middle" style={{ width: 56, height: 56 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="block h-full w-full object-cover" />
      {onRemove ? (
        <button type="button" onClick={onRemove} className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full border-0 bg-black/55 text-white" aria-label={t("i18n.close")}>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      ) : null}
    </span>
  );
}

function imageFrameStyle(width: number, height: number) {
  return {
    aspectRatio: `${width} / ${height}`,
    width: `min(100%, calc(28rem * ${width / height}))`,
  };
}

function caption(details: ImageGenerationResult, t: (key: string) => string): string {
  const parts: string[] = [];
  if (details.size === "auto") parts.push(t("image.aspectAuto"));
  else if (details.size) parts.push(details.size);
  if (details.resolution) parts.push(details.resolution.toUpperCase());
  if (details.quality === "low") parts.push(t("image.qualityLow"));
  else if (details.quality === "medium") parts.push(t("image.qualityMedium"));
  else if (details.quality === "auto") parts.push(t("image.qualityAuto"));
  else if (details.quality) parts.push(details.quality);
  return parts.join(" · ");
}

export function GeneratedImageResult({ value, cwd, onEdit, onMention, showPrompt = false }: {
  value: unknown;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onEdit?: (details: ImageGenerationResult) => void;
  onMention?: (path: string) => void;
  showPrompt?: boolean;
}) {
  const { t } = useI18n();
  const details = getImageGenerationResult(value);
  const [failed, setFailed] = useState(false);
  if (!details) return null;
  const absolutePath = details.path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(details.path)
    ? details.path
    : cwd ? joinFilePath(cwd, details.path) : details.path;
  const preview = fileUrl(absolutePath, "read");
  const summary = caption(details, t);

  return (
    <article className="mb-3 mt-2 w-fit max-w-full">
      <div className="relative max-w-full overflow-hidden rounded-[10px] border border-border/80 bg-bg-panel" style={imageFrameStyle(details.width, details.height)}>
        {failed ? (
          <div className="flex h-full min-h-28 items-center justify-center px-4 text-xs text-text-muted">{t("chat.imagePreviewUnavailable")}</div>
        ) : (
          <ImagePreview src={preview} alt={details.prompt} className="block h-full w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt={details.prompt} loading="lazy" onError={() => setFailed(true)} className="block h-full w-full object-cover" />
          </ImagePreview>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end p-2">
          <div className="pointer-events-auto flex items-center rounded-full bg-black/50 p-0.5 text-white backdrop-blur-sm">
            {onEdit ? (
              <button type="button" onClick={(event) => { event.stopPropagation(); onEdit(details); }} title={t("image.edit")} className="h-7 rounded-full px-2.5 text-[11px] font-medium tracking-wide text-white/95 hover:bg-white/15">
                {t("image.edit")}
              </button>
            ) : null}
            {onEdit ? <span className="mx-0.5 h-3 w-px bg-white/25" aria-hidden="true" /> : null}
            {onMention ? (
              <button type="button" onClick={(event) => { event.stopPropagation(); onMention(details.path); }} title={t("image.quote")} aria-label={t("image.quote")} className="inline-flex h-7 w-7 items-center justify-center rounded-full text-white/95 hover:bg-white/15">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 17 4 12l5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>
              </button>
            ) : null}
            <a href={fileUrl(absolutePath, "download")} download title={t("i18n.downloadFile")} aria-label={t("i18n.downloadFile")} onClick={(event) => event.stopPropagation()} className="inline-flex h-7 w-7 items-center justify-center rounded-full text-white/95 hover:bg-white/15">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5M12 15V3" /></svg>
            </a>
          </div>
        </div>
      </div>
      {showPrompt && details.prompt ? (
        <p className="mt-1.5 line-clamp-3 text-[12px] leading-snug text-text-muted" title={details.prompt}>{details.prompt}</p>
      ) : null}
      {summary ? <div className={`${showPrompt && details.prompt ? "mt-1" : "mt-1.5"} text-[11px] tracking-wide text-text-dim`}>{summary}</div> : null}
    </article>
  );
}

function pendingAspect(size?: string, fallback?: { width?: number; height?: number }): { w: number; h: number } {
  if (size && size !== "auto") {
    const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(size.trim());
    if (ratio) return { w: Number(ratio[1]), h: Number(ratio[2]) };
    const pixels = /^(\d+)x(\d+)$/.exec(size.trim());
    if (pixels) return { w: Number(pixels[1]), h: Number(pixels[2]) };
  }
  if (fallback?.width && fallback.height) return { w: fallback.width, h: fallback.height };
  return { w: 1, h: 1 };
}

export function PendingGeneratedImage({ prompt, size, width, height, previewUrl }: {
  prompt?: string;
  size?: string;
  width?: number;
  height?: number;
  previewUrl?: string;
}) {
  const { t } = useI18n();
  const { w, h } = pendingAspect(size, { width, height });
  return (
    <article className="mb-3 mt-2 w-fit max-w-full">
      <div
        role="status"
        aria-label={t("image.generating")}
        className="relative max-w-full overflow-hidden rounded-[10px] border border-border/80 bg-bg-panel"
        style={imageFrameStyle(w, h)}
      >
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-35" />
        ) : null}
        <div className="image-pending-sheen" aria-hidden="true" />
      </div>
      {prompt ? <p className="mt-1.5 line-clamp-3 text-[12px] leading-snug text-text-muted">{prompt}</p> : null}
    </article>
  );
}
