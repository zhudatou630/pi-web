export interface MarkdownOutlineItem {
  level: 1 | 2 | 3;
  text: string;
}

/** Fold h3 under the nearest h1/h2 once the outline is longer than this. */
export const OUTLINE_FOLD_AFTER = 20;

export function outlineParentIndex(items: MarkdownOutlineItem[], index: number): number {
  if (items[index]?.level !== 3) return -1;
  for (let i = index - 1; i >= 0; i--) {
    if (items[i].level < 3) return i;
  }
  return -1;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

export function extractMarkdownOutline(markdown: string): MarkdownOutlineItem[] {
  const items: MarkdownOutlineItem[] = [];
  let fence: { ch: string; n: number } | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMark = FENCE.exec(line);
    if (fenceMark) {
      const ch = fenceMark[1][0];
      const n = fenceMark[1].length;
      if (!fence) fence = { ch, n };
      else if (fence.ch === ch && n >= fence.n) fence = null;
      continue;
    }
    if (fence) continue;

    const heading = ATX.exec(line);
    if (!heading) continue;
    const text = heading[2]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();
    if (text) items.push({ level: heading[1].length as 1 | 2 | 3, text });
  }

  return items;
}
