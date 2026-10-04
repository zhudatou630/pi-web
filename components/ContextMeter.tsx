"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "@/hooks/useTheme";

interface ContextMeterProps {
  /** Filled part of the meter, 0–100. */
  percent: number;
  /** Base color of the filled cells (a CSS color, may be a `var()`). */
  fill: string;
  label: string;
}

const CELL_PITCH_CSS = 4;

/** Resolve CSS colors (e.g. `var()`) to values canvas accepts, in `host`'s cascade. */
function resolveColors(host: HTMLElement, colors: readonly string[]): string[] {
  const probe = document.createElement("span");
  probe.style.display = "none";
  host.appendChild(probe);
  try {
    return colors.map((color) => {
      probe.style.color = "";
      probe.style.color = color;
      return getComputedStyle(probe).color;
    });
  } finally {
    probe.remove();
  }
}

/**
 * Cell meter drawn in device pixels: a CSS mask cannot keep 3px cells and 1px gaps even
 * at fractional scales (1.25x, 1.5x) or fractional offsets, so cells there come out
 * uneven or blurred. Every cell here is a whole number of device pixels wide.
 */
export function ContextMeter({ percent, fill, label }: ContextMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const deviceSizeRef = useRef<{ width: number; height: number } | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const { theme, palette } = useTheme();

  drawRef.current = () => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const dpr = window.devicePixelRatio || 1;
    // Layout size, not getBoundingClientRect(): the panel opens with a transform animation.
    const estimated = { width: Math.round(canvas.clientWidth * dpr), height: Math.round(canvas.clientHeight * dpr) };
    // The exact box can differ from the estimate only by pixel snapping. Emulated scales
    // (DevTools device mode, headless) report it in CSS pixels; ignore it there.
    const exact = deviceSizeRef.current;
    const { width, height } = exact && Math.abs(exact.width - estimated.width) <= 1 ? exact : estimated;
    if (width <= 0 || height <= 0) return;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const [empty, filled] = resolveColors(host, ["var(--border)", fill]);
    const gap = Math.max(1, Math.round(dpr));
    const pitch = Math.max(gap + 1, Math.round(CELL_PITCH_CSS * dpr));
    const cells = Math.floor((width + gap) / pitch);
    // Round up to whole cells, so any nonzero usage shows at least one.
    const filledCells = Math.min(cells, Math.ceil((Math.max(0, percent) / 100) * cells - 1e-9));

    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < cells; i++) {
      ctx.fillStyle = i < filledCells ? filled : empty;
      ctx.fillRect(i * pitch, 0, pitch - gap, height);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const box = entry.devicePixelContentBoxSize?.[0];
      // Safari lacks devicePixelContentBoxSize; rounding the CSS size is the fallback.
      deviceSizeRef.current = box
        ? { width: box.inlineSize, height: box.blockSize }
        : null;
      drawRef.current();
    });
    try {
      observer.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(canvas);
    }
    return () => observer.disconnect();
  }, []);

  // Theme classes are applied before this commit; draw on the next frame so the cascade is settled.
  useEffect(() => {
    const frame = requestAnimationFrame(() => drawRef.current());
    return () => cancelAnimationFrame(frame);
  }, [percent, fill, theme, palette]);

  return (
    <canvas
      ref={canvasRef}
      className="session-stats-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent * 10) / 10}
    />
  );
}
