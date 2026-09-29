"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ImageViewer, type ViewerImage } from "./ImageViewer";

const MAX_VISIBLE = 6;

/** Uniform square thumbnails for the images of one message; click opens the whole set in the viewer. */
export function ImageThumbs({ images, style }: { images: ViewerImage[]; style?: React.CSSProperties }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  if (!images.length) return null;
  const hidden = images.length - MAX_VISIBLE;
  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, ...style }}>
        {images.slice(0, MAX_VISIBLE).map((image, i) => (
          <button key={i} type="button" className="image-thumb" onClick={() => setOpen(i)} aria-label={t("chat.previewImage")} title={t("chat.previewImage")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.src} alt={image.alt ?? ""} loading="lazy" decoding="async" />
            {hidden > 0 && i === MAX_VISIBLE - 1 && <span className="image-thumb-more">+{hidden}</span>}
          </button>
        ))}
      </div>
      {open !== null && <ImageViewer items={images} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}
