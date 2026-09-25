import type { CSSProperties } from "react";
import { iconStroke } from "./iconStroke";

export function SubagentIcon({
  size = 13,
  className,
  style,
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={iconStroke(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ flexShrink: 0, ...style }}
    >
      <rect x="2" y="8" width="14" height="14" rx="2" />
      <path d="M8 2h12a2 2 0 0 1 2 2v12" />
    </svg>
  );
}
