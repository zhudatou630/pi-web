/** Prompt-cache glyph (a database cylinder), shared by the transcript refresh marker and the sidebar. */
export function CacheKeepaliveIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={Math.round(176 / size) / 10 /* ~1.1px on screen, 16-unit grid */} strokeLinecap="round" aria-hidden="true">
      <ellipse cx="8" cy="3.5" rx="5" ry="1.8" /><path d="M3 3.5v9a5 1.8 0 0 0 10 0v-9" /><path d="M3 8a5 1.8 0 0 0 10 0" />
    </svg>
  );
}
