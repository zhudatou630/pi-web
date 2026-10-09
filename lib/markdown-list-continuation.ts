export interface TextareaEdit {
  start: number;
  end: number;
  text: string;
}

const BULLET_ITEM = /^([ \t]*)([-*+])([ \t]+)(\[[ xX]\](?:[ \t]+|$))?/;
const ORDERED_ITEM = /^([ \t]*)(\d{1,9})([.)])([ \t]+)(\[[ xX]\](?:[ \t]+|$))?/;
const CJK_ORDERED_ITEM = /^([ \t]*)(\d{1,3})(、)([ \t]*)/;
const THEMATIC_BREAK = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const CODE_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

function isInsideFencedCode(textBeforeLine: string): boolean {
  let openFence: string | null = null;
  for (const line of textBeforeLine.split("\n")) {
    const fence = CODE_FENCE.exec(line)?.[1];
    if (!fence) continue;
    if (openFence === null) openFence = fence;
    else if (fence[0] === openFence[0] && fence.length >= openFence.length && line.trim() === fence) openFence = null;
  }
  return openFence !== null;
}

/** Continue a list or remove an empty marker; selections and fenced code keep native newlines. */
export function getMarkdownListContinuation(value: string, selectionStart: number, selectionEnd: number): TextareaEdit | null {
  if (selectionStart !== selectionEnd) return null;
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const newlineIndex = value.indexOf("\n", selectionStart);
  const lineEnd = newlineIndex === -1 ? value.length : newlineIndex;
  const line = value.slice(lineStart, lineEnd);
  if (THEMATIC_BREAK.test(line) || isInsideFencedCode(value.slice(0, lineStart))) return null;
  const bullet = BULLET_ITEM.exec(line);
  const ordered = bullet ? null : ORDERED_ITEM.exec(line) ?? CJK_ORDERED_ITEM.exec(line);
  const item = bullet ?? ordered;
  if (!item || selectionStart - lineStart < item[0].length) return null;
  if (line.slice(item[0].length).trim() === "") return { start: lineStart, end: lineEnd, text: "" };
  const prefix = bullet
    ? `${bullet[1]}${bullet[2]}${bullet[3]}${bullet[4] !== undefined ? "[ ] " : ""}`
    : `${item[1]}${String(Number(item[2]) + 1).padStart(item[2].length, "0")}${item[3]}${item[4]}${item[5] !== undefined ? "[ ] " : ""}`;
  return { start: selectionStart, end: selectionStart, text: `\n${prefix}` };
}
