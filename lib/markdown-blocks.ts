const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
const HTML_TAG = /<[A-Za-z!/?]/;
const INLINE_CODE = /`[^`]*`/g;

/**
 * Splits markdown before top-level blocks that cannot belong to the block
 * above, so a streaming message renders block by block: finished blocks keep
 * their parse and only the last one is parsed again as text arrives (one parse
 * of the whole reply per chunk made a long reply quadratic). The pieces join
 * back to the input.
 *
 * A split goes only after a blank line, before a line that starts at column 0
 * and is not a list item: never inside a code fence or a `$$` math block,
 * never inside a loose list or an indented continuation. Raw HTML may wrap
 * blank lines (`<details>`, an inline `<b>` left open), so nothing after the
 * first line with a tag outside inline code is split, nor is a document
 * opening with front matter. A rare miss only makes a block larger
 * or, at worst, renders one transiently apart while streaming: the finished
 * message is rendered whole.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.split("\n");
  if (/^---[ \t]*\r?$/.test(lines[0])) return [markdown];
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { marker: string; size: number } | null = null;
  let inMath = false;
  let rawHtml = false;
  let afterBlank = false;

  for (const line of lines) {
    const blank = line.trim() === "";
    if (afterBlank && !blank && !fence && !inMath && !rawHtml && current.length > 0
      && !/^[ \t]/.test(line) && !LIST_ITEM.test(line)) {
      blocks.push(current.join("\n") + "\n");
      current = [];
    }
    current.push(line);

    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const size = fenceMatch[1].length;
      if (!fence) fence = { marker, size };
      else if (marker === fence.marker && size >= fence.size) fence = null;
    } else if (!fence) {
      const prose = line.replace(INLINE_CODE, "");
      if (HTML_TAG.test(prose)) rawHtml = true;
      if ((prose.match(/\$\$/g)?.length ?? 0) % 2 === 1) inMath = !inMath;
    }
    afterBlank = blank;
  }
  blocks.push(current.join("\n"));
  return blocks;
}

/** Only the unambiguous top-level code fence case; the normal parser owns everything else. */
export function parseStreamingFence(markdown: string): { lang: string; code: string } | null {
  if (/[\r\u0000\u2028\u2029]/.test(markdown)) return null;
  const headerEnd = markdown.indexOf("\n");
  const header = markdown.slice(0, headerEnd < 0 ? undefined : headerEnd);
  const open = /^(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/.exec(header);
  if (!open || /[\\&]/.test(header)) return null;
  const lang = open[2].toLowerCase();
  if (["math", "mermaid", "svg"].includes(lang)) return null;
  // Empty unlabelled fences take the inline-code renderer in our existing markdown path.
  if (headerEnd < 0) return lang ? { lang, code: "" } : null;
  const body = markdown.slice(headerEnd + 1);
  const closing = /^( {0,3})(`{3,}|~{3,})[ \t]*(?:\n|$)/gm;
  for (const match of body.matchAll(closing)) {
    if (match[2][0] !== open[1][0] || match[2].length < open[1].length) continue;
    if (body.slice(match.index + match[0].length).trim()) return null;
    const code = body.slice(0, Math.max(0, match.index - 1));
    return !lang && !code ? null : { lang, code };
  }
  const code = body.replace(/\n$/, "");
  return !lang && !code ? null : { lang, code };
}

export interface StreamingCodePieces {
  code: string;
  frozen: string[];
  offset: number;
  scanned: number;
  lines: number;
}

/** Append-only scans start at the new suffix; a rewritten fence resets the cuts. */
export function streamingCodePieces(code: string, previous?: StreamingCodePieces): StreamingCodePieces {
  const keep = previous && code.startsWith(previous.code);
  const state: StreamingCodePieces = keep
    ? { ...previous, code, frozen: [...previous.frozen] }
    : { code, frozen: [], offset: 0, scanned: 0, lines: 0 };
  for (let i = code.indexOf("\n", state.scanned); i >= 0; i = code.indexOf("\n", i + 1)) {
    if (++state.lines === 64) {
      // Blocks supply the boundary newline; retaining it here doubles a copied line break.
      state.frozen.push(code.slice(state.offset, i));
      state.offset = i + 1;
      state.lines = 0;
    }
  }
  state.scanned = code.length;
  return state;
}
