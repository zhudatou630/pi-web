import type { CSSProperties } from "react";

export function ThinkingIcon({
  active,
  size = 14,
  className,
  style,
}: {
  active?: boolean;
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
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{
        flexShrink: 0,
        color: active ? "var(--accent)" : "currentColor",
        display: "block",
        ...style,
      }}
    >
      <path d="M9.5 4a3.5 3.5 0 0 0-3.5 3.5c0 .34.05.67.14.98A4 4 0 0 0 4 12c0 1.9 1.3 3.5 3.1 3.9A3.5 3.5 0 0 0 10.5 19h1" />
      <path d="M14.5 4a3.5 3.5 0 0 1 3.5 3.5c0 .34-.05.67-.14.98A4 4 0 0 1 20 12c0 1.9-1.3 3.5-3.1 3.9A3.5 3.5 0 0 1 13.5 19h-1" />
      <path d="M12 4v16" />
    </svg>
  );
}
