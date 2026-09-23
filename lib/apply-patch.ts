import type { SplitDiffCell, SplitDiffRow } from "./patch";

/**
 * Rendering support for Codex-style `apply_patch` tools.
 *
 * The tool call input is a freeform V4A patch document that may contain several
 * file operations in one call:
 *
 *   *** Begin Patch
 *   *** Add File: new.ts
 *   +line
 *   *** Update File: old.ts
 *   *** Move to: renamed.ts
 *   @@ optional context marker
 *    context
 *   -removed
 *   +added
 *   *** Delete File: gone.ts
 *   *** End Patch
 *
 * V4A hunks carry no line numbers, so this parses straight into the shared
 * `SplitDiffFile` model instead of going through a unified-diff text round trip
 * (which would have to invent `@@` counts). Lines are numbered by counting from
 * the start of each file, which is what the reader needs to orient themselves.
 */

export interface ApplyPatchFile {
  /** Path as written in the patch; may be relative to the session cwd. */
  path: string;
  /** `*** Move to:` target for an update. */
  moveTo?: string;
  operation: "add" | "update" | "delete";
  rows: SplitDiffRow[];
}

const FILE_MARKER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE_MARKER = /^\*\*\* Move to: (.+)$/;

function emptyCell(): SplitDiffCell {
  return { lineNo: null, text: "", type: "empty" };
}

/**
 * Parse a V4A patch document into renderable file diffs.
 *
 * Returns null when the text is not a V4A document, so callers can fall back to
 * showing the raw input (for example while arguments are still streaming).
 */
export function parseApplyPatch(text: string): ApplyPatchFile[] | null {
  if (!text.includes("*** Begin Patch")) return null;

  const files: ApplyPatchFile[] = [];
  let current: ApplyPatchFile | null = null;
  let inHunk = false;
  let removed: { lineNo: number | null; text: string }[] = [];
  let added: { lineNo: number | null; text: string }[] = [];

  const flushChanges = () => {
    if (!current) {
      removed = [];
      added = [];
      return;
    }
    const count = Math.max(removed.length, added.length);
    for (let index = 0; index < count; index += 1) {
      const left = removed[index]
        ? { lineNo: removed[index]!.lineNo, text: removed[index]!.text, type: "removed" as const }
        : emptyCell();
      const right = added[index]
        ? { lineNo: added[index]!.lineNo, text: added[index]!.text, type: "added" as const }
        : emptyCell();
      current.rows.push({ type: "line", left, right });
    }
    removed = [];
    added = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
      flushChanges();
      inHunk = false;
      continue;
    }

    const fileMarker = line.match(FILE_MARKER);
    if (fileMarker) {
      flushChanges();
      inHunk = false;
      const operation = fileMarker[1]!.toLowerCase() as ApplyPatchFile["operation"];
      current = { path: fileMarker[2]!.trim(), operation, rows: [] };
      files.push(current);
      continue;
    }

    if (!current) continue;

    const moveMarker = line.match(MOVE_MARKER);
    if (moveMarker) {
      current.moveTo = moveMarker[1]!.trim();
      continue;
    }

    // `@@` starts (or re-anchors) a hunk. Any trailing text is a context hint
    // V4A uses to locate the edit, not a line-number range.
    if (line.startsWith("@@")) {
      flushChanges();
      inHunk = true;
      current.rows.push({ type: "hunk", text: line });
      continue;
    }

    if (line.startsWith("*** ")) {
      // An unrecognized directive (e.g. a future marker). Return null so the caller
      // shows the whole raw patch: keeping the structured rows this far and then
      // dropping the body lines that follow would silently render a partial diff,
      // which is worse than showing the raw document.
      return null;
    }

    if (line === "") {
      // A bare blank line is NOT a context line. V4A renders empty content as
      // " " / "+" / "-"; a bare newline only ever separates hunks or files. Treating
      // it as context fabricated a phantom empty row (and shifted every later line
      // number) on the very common trailing newline before `*** End Patch`.
      flushChanges();
      continue;
    }

    if (!inHunk && current.operation === "update") {
      // An update's body always sits under a `@@` header. Add and Delete put their
      // lines directly after the file marker.
      continue;
    }

    const prefix = line[0] ?? "";
    const content = line.slice(1);

    // V4A hunks carry no line numbers: `@@` is a locator hint. Counting patch rows
    // and presenting that as the file position would be wrong by hundreds of lines
    // on a real patch, so the number column stays blank instead of misleading.
    if (prefix === "+") {
      added.push({ lineNo: null, text: content });
    } else if (prefix === "-") {
      removed.push({ lineNo: null, text: content });
    } else if (prefix === " ") {
      flushChanges();
      current.rows.push({
        type: "line",
        left: { lineNo: null, text: content, type: "context" },
        right: { lineNo: null, text: content, type: "context" },
      });
    }
  }

  flushChanges();

  return files.length > 0 ? files : null;
}

/** The paths a patch touches, in document order. Used to list changed files. */
export function applyPatchPaths(text: string): string[] {
  const parsed = parseApplyPatch(text);
  if (!parsed) return [];
  const paths: string[] = [];
  for (const file of parsed) {
    const target = file.moveTo ?? file.path;
    if (target && !paths.includes(target)) paths.push(target);
  }
  return paths;
}
