import type { CSSProperties } from "react";

interface Props {
  size?: number;
  title?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

/** The running dot (8px, breathing) centered in a `size` box, for live rows outside the sidebar. */
export function LivePulseBeacon({
  size = 14,
  title,
  ariaLabel,
  className,
  style,
}: Props) {
  return (
    <span
      className={`live-pulse-beacon${className ? ` ${className}` : ""}`}
      title={title}
      aria-label={ariaLabel}
      style={{
        width: size,
        height: size,
        ...style,
      }}
    >
      <span className="session-status-dot" data-status="running" aria-hidden="true" />
    </span>
  );
}
