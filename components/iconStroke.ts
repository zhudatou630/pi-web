// An icon is sized to the text it sits with: box = text size + 1 (11px text -> 12,
// 12px -> 13, 13px -> 14), which puts a 24-unit icon's ink at the height of a CJK glyph.
// Stroke keeps ~1.1px on screen at any size; the value is in 24-unit viewBox units.
export function iconStroke(size: number): number {
  return Math.round(264 / size) / 10;
}
