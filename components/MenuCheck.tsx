import { iconStroke } from "./iconStroke";

/** Trailing selection mark of a menu row. Hidden rather than absent, so other trailing columns line up. */
export function MenuCheck({ checked }: { checked: boolean }) {
  return (
    <svg className="menu-surface-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={iconStroke(13)} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={checked ? undefined : { visibility: "hidden" }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
