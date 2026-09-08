import type { CSSProperties } from "react";

interface Props {
  size?: number;
  title?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

export function LivePulseBeacon({
  size = 14,
  title,
  ariaLabel,
  className,
  style,
}: Props) {
  const coreSize = size <= 10 ? 4 : 5;
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
      <span
        className="live-pulse-beacon-halo"
        style={{ width: coreSize, height: coreSize }}
        aria-hidden="true"
      />
      <span
        className="live-pulse-beacon-core"
        style={{ width: coreSize, height: coreSize }}
        aria-hidden="true"
      />
    </span>
  );
}
