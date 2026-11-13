import type { SplitDiffCell, SplitDiffFile, SplitDiffRow } from "./patch";

type Edit = { oldText: string; newText: string };
const isEdit = (value: unknown): value is Edit => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && typeof (value as Edit).oldText === "string" && typeof (value as Edit).newText === "string");

/** Mirrors SDK prepareEditArguments without mutating the streamed/saved input. */
export function editPreview(input: unknown): SplitDiffFile[] | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const args = input as Record<string, unknown>;
  let value = args.edits;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { /* legacy fields may still provide an edit */ }
  }
  const edits: unknown[] = Array.isArray(value) ? [...value] : isEdit(value) ? [value] : [];
  const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
  if (isEdit(args)) edits.push({ oldText: args.oldText, newText: args.newText });
  if (!edits.length || !edits.every(isEdit)) return null;
  if (!path?.trim()) return null;
  const rows: SplitDiffRow[] = [];
  const gap = () => {
    if (rows.at(-1)?.type !== "hunk") rows.push({ type: "hunk", text: "", skippedLines: null });
  };
  const cell = (text: string | undefined, type: SplitDiffCell["type"]): SplitDiffCell => {
    let end = 4000;
    if (text && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
    return { lineNo: null, text: text === undefined ? "" : text.length > 4000 ? text.slice(0, end) + "…" : text, type: text === undefined ? "empty" : type };
  };
  let count = 0;
  for (const [index, edit] of edits.entries()) {
    if (index) gap();
    const before = edit.oldText ? edit.oldText.replace(/\r\n?/g, "\n").split("\n") : [];
    const after = edit.newText ? edit.newText.replace(/\r\n?/g, "\n").split("\n") : [];
    if (before.at(-1) === "") before.pop();
    if (after.at(-1) === "") after.pop();
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if (count++ === 1000) { gap(); return [{ oldPath: path, newPath: path, rows }]; }
      rows.push({ type: "line", left: cell(before[i], "removed"), right: cell(after[i], "added") });
    }
  }
  return rows.some((row) => row.type === "line") ? [{ oldPath: path, newPath: path, rows }] : null;
}
