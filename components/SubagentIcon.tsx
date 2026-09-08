import type { CSSProperties } from "react";

export function SubagentIcon({
  size = 14,
  strokeWidth = 2,
  className,
  style,
}: {
  size?: number;
  strokeWidth?: number;
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
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ flexShrink: 0, ...style }}
    >
      <rect x="3" y="7" width="13" height="13" rx="2" />
      <path d="M8 3h10a2 2 0 0 1 2 2v10" />
    </svg>
  );
}
