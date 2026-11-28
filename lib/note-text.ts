/** Plain-text views of a note: its first line is the title, `- [ ]` lines are its todos (docs/notes.md). */

// Quote markers count too: GFM renders `> - [ ] x` as a checkbox, and ordinals must match the DOM.
const TASK = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/;
const FENCE = /^\s*(?:>\s*)*(```|~~~)/;

/** Line indexes of task items, in document order, outside fenced code (what GFM renders as checkboxes). */
function taskLines(lines: readonly string[]): number[] {
  const found: number[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker) { fence = fence === null ? marker : fence === marker ? null : fence; return; }
    if (fence === null && TASK.test(line)) found.push(index);
  });
  return found;
}

export function noteTitle(text: string): string {
  const line = text.split("\n").find((item) => item.trim()) ?? "";
  // A heading, bullet or todo marker is syntax, not the title.
  return line.trim().replace(/^#+\s*/, "").replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, "");
}

export function notePreview(text: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((item) => item.trim());
  return lines.slice(first + 1).map((line) => line.trim().replace(TASK, "").trim()).filter(Boolean).join(" ").slice(0, 200);
}

export function noteTaskCounts(text: string): { done: number; total: number } {
  const lines = text.split("\n");
  const tasks = taskLines(lines);
  return { done: tasks.filter((index) => TASK.exec(lines[index])![2] !== " ").length, total: tasks.length };
}

/**
 * Notes by tag: tags in name order, untagged last, newest edit first inside. Nothing tagged is one
 * untagged group, shown without a heading.
 */
export function groupNotesByTag<T extends { tag: string | null; updatedAt: number }>(notes: readonly T[]): { tag: string | null; notes: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const note of [...notes].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const list = groups.get(note.tag);
    if (list) list.push(note);
    else groups.set(note.tag, [note]);
  }
  return [...groups].map(([tag, list]) => ({ tag, notes: list }))
    .sort((a, b) => a.tag === null ? 1 : b.tag === null ? -1 : a.tag.localeCompare(b.tag));
}

/** A replacement in the editor: `text[from, to)` becomes `insert`, then the selection. */
export interface NoteTextEdit { from: number; to: number; insert: string; selectionStart: number; selectionEnd: number }

const TASK_PREFIX = /^(\s*)(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s?/;

/**
 * The editor's todo button: the selected lines become `- [ ] ` items (a plain `- ` bullet keeps its
 * text), or, when they all are items already, plain lines again.
 */
export function toggleTaskLines(text: string, start: number, end: number): NoteTextEdit {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  // A selection ending at a line start does not take that line.
  const lineEnd = text.indexOf("\n", end > start && text[end - 1] === "\n" ? end - 1 : end);
  const to = lineEnd < 0 ? text.length : lineEnd;
  const lines = text.slice(from, to).split("\n");
  const filled = lines.filter((line) => line.trim());
  const remove = filled.length > 0 && filled.every((line) => TASK_PREFIX.test(line));
  const insert = lines.map((line) => {
    if (remove) return line.replace(TASK_PREFIX, "$1");
    if (TASK_PREFIX.test(line) || (!line.trim() && lines.length > 1)) return line;
    return line.replace(/^(\s*)(?:[-*+]\s+)?/, "$1- [ ] ");
  }).join("\n");
  if (lines.length > 1) return { from, to, insert, selectionStart: from, selectionEnd: from + insert.length };
  const caret = Math.max(from, start + insert.length - (to - from));
  return { from, to, insert, selectionStart: caret, selectionEnd: caret };
}

/**
 * Enter at the end of a todo item starts the next one; Enter on an empty item ends the list.
 * Null: a plain Enter.
 */
export function continueTaskOnEnter(text: string, caret: number): NoteTextEdit | null {
  const from = text.lastIndexOf("\n", caret - 1) + 1;
  const lineEnd = text.indexOf("\n", caret);
  const to = lineEnd < 0 ? text.length : lineEnd;
  const match = TASK_PREFIX.exec(text.slice(from, to));
  if (!match || caret < from + match[0].length) return null;
  if (!text.slice(from + match[0].length, to).trim()) {
    return { from, to, insert: match[1], selectionStart: from + match[1].length, selectionEnd: from + match[1].length };
  }
  const insert = `\n${match[1]}- [ ] `;
  return { from: caret, to: caret, insert, selectionStart: caret + insert.length, selectionEnd: caret + insert.length };
}

/**
 * Flips the checkbox of the list item the renderer placed at `offset` (its marker); anything else
 * there leaves the text as it is. The renderer's own position, not a count of our own, so code
 * blocks, quotes and HTML can never shift which line is written.
 */
export function toggleNoteTaskAt(text: string, offset: number): string {
  const match = /^(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]/.exec(text.slice(offset, offset + 32));
  if (!match) return text;
  const at = offset + match[0].length - 2;
  return text.slice(0, at) + (match[1] === " " ? "x" : " ") + text.slice(at + 1);
}
