// Client-safe part of lib/app-identity.ts (that one reads the agent dir).

export const APP_ICON_COLORS = {
  default: "#000000",
  blue: "#2563eb",
  green: "#15803d",
  orange: "#ea580c",
  red: "#dc2626",
  purple: "#7c3aed",
  teal: "#0f766e",
  pink: "#db2777",
} as const;

export type AppIconColor = keyof typeof APP_ICON_COLORS;

export interface AppIdentity {
  /** Empty: PI_WEB_APP_NAME, then "Pi Web". */
  name: string;
  color: AppIconColor;
}

export const APP_NAME_MAX_LENGTH = 40;

// The stock mark (public/favicon.svg) in a 560 box. One path: separate ones leave an anti-aliased seam where they touch.
export const APP_MARK_PATH = "M420 280H280V140H0V0H420V280Z M560 560H420V280H560V560Z M140 560H0V140H140V280H280V420H140V560Z";
