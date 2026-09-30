"use client";

import { useState } from "react";
import { ImagePreview } from "./ImagePreview";
import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi, joinFilePath } from "@/lib/file-paths";
import { getImageGenerationResult, imageDisplayRatio, type ImageGenerationResult } from "@/lib/image-generation";

function fileUrl(filePath: string, type: "read" | "download"): string {
  return `/api/files/${encodeFilePathForApi(filePath)}?type=${type}`;
}

function absoluteImagePath(path: string, cwd?: string): string {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) ? path : cwd ? joinFilePath(cwd, path) : path;
}

export function mentionImageUrl(path: string, cwd?: string): string {
  return fileUrl(absoluteImagePath(path, cwd), "read");
}

/** Composer chip for an @-mentioned image file: same thumbnail as an attachment, click to preview. */
export function ImageMentionChip({ path, cwd, onRemove }: {
  path: string;
  cwd?: string;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const src = mentionImageUrl(path, cwd);
  return (
    <div className="chat-input-image-preview">
      <ImagePreview src={src} className="image-thumb">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" decoding="async" />
      </ImagePreview>
      {onRemove ? (
        <button type="button" className="chat-input-image-remove" onClick={onRemove} title={t("i18n.close")} aria-label={t("i18n.close")}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      ) : null}
    </div>
  );
}

function imageFrameStyle(width: number, height: number) {
  return {
    aspectRatio: `${width} / ${height}`,
    width: "100%",
    maxWidth: "520px",
    maxHeight: "min(60vh, 520px)",
  };
}

function qualityLabel(details: ImageGenerationResult, t: (key: string) => string): string | undefined {
  if (details.quality === "low") return t("image.qualityLow");
  if (details.quality === "medium") return t("image.qualityMedium");
  if (details.quality === "high") return t("image.qualityHigh");
  if (details.quality === "auto") return t("image.qualityAuto");
  return details.quality;
}

function formatImageTime(createdAt: number, locale: string): string {
  const date = new Date(createdAt);
  const now = new Date();
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return time;
  const day = date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
  return `${day} ${time}`;
}

function shortImageModel(details: ImageGenerationResult): string {
  if (details.label) return details.label;
  if (details.model.includes("sunburst")) return "Sunburst";
  if (details.model.includes("flare")) return "Flare";
  if (details.model.includes("grok-imagine")) return "Grok";
  if (details.model.includes("flash-image")) return "Banana 2";
  return details.model;
}

function sizeCaption(details: ImageGenerationResult): string {
  const ratio = imageDisplayRatio(details.width, details.height);
  const pixels = `${details.width}\u00d7${details.height}`;
  return ratio === `${details.width}:${details.height}` ? pixels : `${ratio}（${pixels}）`;
}

function caption(details: ImageGenerationResult, t: (key: string) => string): string {
  const parts = [sizeCaption(details)];
  if (details.resolution) parts.push(details.resolution.toUpperCase());
  const quality = qualityLabel(details, t);
  if (quality) parts.push(quality);
  return parts.join(" \u00b7 ");
}

export function GeneratedImageResult({ value, cwd, onEdit, onMention, showPrompt = false, createdAt }: {
  value: unknown;
  cwd?: string;
  onEdit?: (details: ImageGenerationResult) => void;
  onMention?: (path: string) => void;
  showPrompt?: boolean;
  createdAt?: number;
}) {
  const { t, locale } = useI18n();
  const details = getImageGenerationResult(value);
  const [failed, setFailed] = useState(false);
  if (!details) return null;
  const absolutePath = absoluteImagePath(details.path, cwd);
  const preview = fileUrl(absolutePath, "read");
  const summary = caption(details, t);
  const meta = [
    shortImageModel(details),
    createdAt ? formatImageTime(createdAt, locale) : undefined,
  ].filter(Boolean).join(" \u00b7 ");

  return (
    <article className="mb-3 mt-2 w-full max-w-[520px]">
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
              <button type="button" onClick={(event) => { event.stopPropagation(); onEdit(details); }} title={t("image.edit")} className="h-7 rounded-full px-2.5 text-[11px] tracking-wide text-white/95 hover:bg-white/15">
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
      {summary || meta ? (
        <div className={`${showPrompt && details.prompt ? "mt-1" : "mt-1.5"} max-w-full text-[11px] leading-snug tracking-wide text-text-muted`} title={details.model}>
          {summary}{summary && meta ? " \u00b7 " : null}{meta}
        </div>
      ) : null}
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
  return { w: 4, h: 3 };
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
    <article className="mb-3 mt-2 w-full max-w-[520px]">
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
        <div className="image-pending-grid" aria-hidden="true" />
        <div className="image-pending-sheen" aria-hidden="true" />
      </div>
      {prompt ? <p className="mt-1.5 line-clamp-3 text-[12px] leading-snug text-text-muted">{prompt}</p> : null}
    </article>
  );
}
