"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ImageViewer, type ViewerImage } from "./ImageViewer";

/**
 * Images of one assistant block or tool result: size-capped so a tall picture never owns the page,
 * and any click opens the whole set in the viewer. Renders a fragment, so the parent decides the layout.
 * "thumb" is the compact form for a collapsed card, "figure" the readable one.
 */
export function ImageGallery({ images, variant = "figure" }: { images: ViewerImage[]; variant?: "figure" | "thumb" }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      {images.map((image, i) => (
        <button key={i} type="button" className="image-gallery-item" onClick={() => setOpen(i)} aria-label={t("chat.previewImage")} title={t("chat.previewImage")}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={`image-gallery-image is-${variant}`} src={image.src} alt={image.alt ?? ""} loading="lazy" decoding="async" />
        </button>
      ))}
      {open !== null && <ImageViewer items={images} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}
