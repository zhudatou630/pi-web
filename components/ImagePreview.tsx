"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ImageViewer } from "./ImageViewer";

interface ImagePreviewProps {
  src: string;
  alt?: string;
  referrerPolicy?: React.HTMLAttributeReferrerPolicy;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/** Wraps a single image as a button that opens it in the viewer. */
export function ImagePreview({ src, alt = "", referrerPolicy, children, className, style }: ImagePreviewProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        style={{
          display: "block",
          padding: 0,
          border: "none",
          background: "none",
          color: "inherit",
          cursor: "zoom-in",
          ...style,
        }}
        onClick={() => setOpen(true)}
        aria-label={t("chat.previewImage")}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("chat.previewImage")}
      >
        {children}
      </button>
      {open && <ImageViewer items={[{ src, alt, referrerPolicy }]} index={0} onIndexChange={() => {}} onClose={() => setOpen(false)} />}
    </>
  );
}
