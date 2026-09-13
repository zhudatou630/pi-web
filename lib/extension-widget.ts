export type ExtensionWidget = { key: string; lines: string[] };

export function applyWidgetEvent(
  current: ExtensionWidget | null,
  key: string,
  lines?: string[],
): ExtensionWidget | null {
  if (lines === undefined) return null;
  if (lines.length === 0) return current;
  return { key, lines };
}
