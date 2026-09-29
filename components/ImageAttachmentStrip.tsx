"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ImageViewer } from "./ImageViewer";

export interface StripImage {
  src: string;
  alt?: string;
}

/** Stable per-image key: survives reorder/removal and tolerates identical images. */
function keysFor(images: StripImage[]): string[] {
  const seen = new Map<string, number>();
  return images.map(({ src }) => {
    const base = `${src.length}:${src.slice(-48)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}

/**
 * Composer-style attachment row shared by the chat input and the image dialog: numbered thumbnails,
 * click to preview, drag or Alt+←/→ to reorder, × to remove. On touch the preview viewer carries
 * the move/remove buttons instead (a long-press drag among 64px thumbnails is hard to aim and
 * fights page scrolling). The first `lockedCount` items are fixed.
 */
export function ImageAttachmentStrip({ images, lockedCount = 0, leading, onMove, onRemove }: {
  images: StripImage[];
  lockedCount?: number;
  /** Extra content rendered before the thumbnails (e.g. @-mentioned files). */
  leading?: React.ReactNode;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useI18n();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const keys = keysFor(images);

  const movable = images.length - lockedCount > 1;

  const move = (from: number, to: number) => {
    dragIndexRef.current = null;
    setDropIndex(null);
    if (from !== to && to >= lockedCount && to < images.length) onMove(from, to);
  };

  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
      {leading}
      {images.map((image, i) => {
        const locked = i < lockedCount;
        return (
          <div
            key={keys[i]}
            className="chat-input-image-preview"
            data-drop={dropIndex === i && dragIndexRef.current !== i ? "true" : undefined}
            draggable={movable && !locked}
            onDragStart={() => { dragIndexRef.current = i; }}
            onDragOver={(event) => {
              if (dragIndexRef.current === null || locked) return;
              event.preventDefault();
              setDropIndex(i);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragIndexRef.current !== null) move(dragIndexRef.current, i);
            }}
            onDragEnd={() => { dragIndexRef.current = null; setDropIndex(null); }}
          >
            <button
              type="button"
              className="image-thumb"
              onClick={() => setPreviewIndex(i)}
              onKeyDown={(event) => {
                if (locked || !event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
                event.preventDefault();
                move(i, i + (event.key === "ArrowLeft" ? -1 : 1));
              }}
              title={movable && !locked ? `${t("chat.previewImage")} (Alt+←/→)` : t("chat.previewImage")}
              aria-label={t("chat.previewImage")}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.src} alt="" draggable={false} decoding="async" />
              {images.length > 1 && <span className="image-thumb-index">{i + 1}</span>}
            </button>
            {!locked && (
              <button type="button" className="chat-input-image-remove" onClick={() => onRemove(i)} title={t("i18n.close")} aria-label={t("i18n.close")}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
      {previewIndex !== null && images[previewIndex] && (
        <ImageViewer
          items={images}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
          edit={{
            lockedCount,
            onMove: (from, to) => { move(from, to); setPreviewIndex(to); },
            onRemove: (index) => {
              onRemove(index);
              setPreviewIndex(images.length > 1 ? Math.min(index, images.length - 2) : null);
            },
          }}
        />
      )}
    </div>
  );
}
