import type { Element as HastElement, Root as HastRoot, RootContent as HastContent } from "hast";
import type { Content, Link, Parent, Root } from "mdast";
import type { Plugin } from "unified";
import type { Extension } from "micromark-util-types";
import { defaultUrlTransform, type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { isProseMathText } from "./markdown-prose-math";

// Link schemes of desktop apps that open a note, a file or a meeting (#1108).
// A fixed list, not "any scheme but javascript:": the text comes from the model
// and from repository files, and OS handlers such as ms-msdt: or search-ms:
// have been exploited through a clicked link.
const appLinkSchemes = [
  "obsidian", "logseq", "notion",
  "vscode", "vscode-insiders", "cursor", "zed", "jetbrains",
  "zoommtg", "zoomus", "msteams", "slack",
];
const appLinkPattern = new RegExp(`^(?:${appLinkSchemes.join("|")}):`, "i");

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file", ...appLinkSchemes],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

/** react-markdown's URL filter, plus links to the apps above. */
export function markdownAppUrlTransform(value: string): string {
  return appLinkPattern.test(value) ? value : defaultUrlTransform(value);
}

/** Also keeps `file:` links, for renderers that open local files in the app. */
export function markdownUrlTransform(value: string): string {
  return /^file:/i.test(value) ? value : markdownAppUrlTransform(value);
}

const escapedInlineCodePattern = /(?<![\\`])`((?:[^`\n]|\\`)+?)(?<![\\`])`(?!`)/g;

function rewriteEscapedInlineCodeBackticks(line: string): string {
  return line.replace(escapedInlineCodePattern, (match, content: string) => {
    const code = content.replace(/\\`/g, "`");
    if (code === content) return match;
    const marker = "`".repeat(Math.max(...(code.match(/`+/g)?.map((run) => run.length) ?? [0])) + 1);
    return `${marker}${code}${marker}`;
  });
}

export function normalizeDisplayMath(markdown: string): string {
  const lineBreak = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const normalized: string[] = [];
  let fence: { marker: string; size: number } | null = null;
  let inlineCodeMarkerSize = 0;
  let rawCodeTag: string | null = null;
  const unmatchedDisplayMathUntil = new Map<string, number>();
  const untouchedCloseAt = new Set<number>();

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];

    if (rawCodeTag) {
      normalized.push(line);
      if (new RegExp(`</${rawCodeTag}\\s*>`, "i").test(line)) rawCodeTag = null;
      continue;
    }

    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const size = fenceMatch[1].length;
      if (!fence) fence = { marker, size };
      else if (marker === fence.marker && size >= fence.size) fence = null;
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (fence) {
      normalized.push(line);
      continue;
    }

    const rawCodeOpen = line.match(/<(code|pre|script|style)\b/i);
    if (rawCodeOpen) {
      const tag = rawCodeOpen[1].toLowerCase();
      const remainder = line.slice((rawCodeOpen.index ?? 0) + rawCodeOpen[0].length);
      if (!new RegExp(`</${tag}\\s*>`, "i").test(remainder)) rawCodeTag = tag;
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    // Nested list items often indent `$$` past 3 spaces. Those lines look like
    // indented code at column 0, but leaving them untouched lets remark-math
    // start a math block it never closes.
    if (line.trim() === "" || (/^(?: {4}|\t)/.test(line) && !/^[ \t]*\$\$/.test(line))) {
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (untouchedCloseAt.has(index)) {
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (!inlineCodeMarkerSize) line = rewriteEscapedInlineCodeBackticks(line);

    if (inlineCodeMarkerSize || line.includes("`")) {
      const startsInCode = inlineCodeMarkerSize > 0;
      inlineCodeMarkerSize = updateInlineCodeMarker(line, inlineCodeMarkerSize);
      // Code spans that open and close on this line: rewrite only the prose around them.
      normalized.push(startsInCode || inlineCodeMarkerSize ? line : normalizeInlineLineOutsideCode(line));
      continue;
    }

    const bracketDisplayOneLine = line.match(/^([ ]{0,3})\\\[[ \t]*(.+?)[ \t]*\\\][ \t]*$/);
    if (bracketDisplayOneLine) {
      const math = bracketDisplayOneLine[2].trim();
      if (math) {
        // Keep the content line indented together with the `$$` fence. When the
        // formula is nested inside a GFM list item (indented `$$`), a content line
        // at column 0 becomes a "lazy continuation" line, which makes remark-math
        // mis-parse the fence pair: the opening `$$` turns into an empty math node
        // and the closing one swallows the rest of the document as math content.
        normalized.push(
          `${bracketDisplayOneLine[1]}$$`,
          `${bracketDisplayOneLine[1]}${math}`,
          `${bracketDisplayOneLine[1]}$$`,
        );
        continue;
      }
    }

    const looseBracketDisplayOneLine = line.match(/^([ ]{0,3})\[[ \t]*(.+?)[ \t]*\][ \t]*$/);
    if (looseBracketDisplayOneLine) {
      const math = looseBracketDisplayOneLine[2].trim();
      if (isLikelyMathExpression(math)) {
        normalized.push(
          `${looseBracketDisplayOneLine[1]}$$`,
          `${looseBracketDisplayOneLine[1]}${math}`,
          `${looseBracketDisplayOneLine[1]}$$`,
        );
        continue;
      }
    }

    const bracketDisplayStart = line.match(/^([ ]{0,3})\\\[[ \t]*$/);
    if (bracketDisplayStart) {
      const closingIndex = findBracketDisplayClose(lines, index + 1);
      if (closingIndex !== -1) {
        // Same lazy-continuation guard as above: indent content lines that sit at
        // column 0 so the block stays parseable when nested inside a list item.
        normalized.push(
          `${bracketDisplayStart[1]}$$`,
          ...lines.slice(index + 1, closingIndex).map((mathLine) =>
            indentDisplayMathContent(mathLine, bracketDisplayStart[1]),
          ),
          `${bracketDisplayStart[1]}$$`,
        );
        index = closingIndex;
        continue;
      }
    }

    const displayMathMatch = line.match(/^([ \t]*)\$\$(.+)\$\$[ \t]*$/);
    if (displayMathMatch) {
      const math = displayMathMatch[2].trim();
      if (math) {
        // See the comment on bracketDisplayOneLine: without matching indentation,
        // a formula nested in a GFM list item is mis-parsed by remark-math and the
        // text after the formula renders as a garbled KaTeX error block.
        normalized.push(
          `${displayMathMatch[1]}$$`,
          `${displayMathMatch[1]}${math}`,
          `${displayMathMatch[1]}$$`,
        );
        continue;
      }
    }

    // remark-math requires both `$$` delimiters to sit on their own lines, but
    // models also emit display math as a multi-line block where the opening `$$`
    // is glued to the first formula line and/or the closing `$$` is glued to the
    // end of the last one (`$$x = 1` + `y = 2$$`). Without normalization such a
    // block swallows the following text as math content and renders as garbage.
    const displayMathMultiLine = line.match(/^([ \t]*)\$\$(.+)$/);
    if (displayMathMultiLine) {
      const indent = displayMathMultiLine[1];
      const firstLine = displayMathMultiLine[2].trimEnd();
      // Only treat this as a block opener if no other `$$` is embedded mid-line
      // (e.g. `$$x$$ and text` stays untouched and is rendered as inline math).
      if (firstLine && !firstLine.includes("$$")) {
        const closing = findDisplayMathClose(
          lines,
          index + 1,
          indent,
          unmatchedDisplayMathUntil,
        );
        if (closing) {
          normalized.push(`${indent}$$`, `${indent}${firstLine}`);
          for (let j = index + 1; j < closing.index; j++) {
            normalized.push(indentDisplayMathContent(lines[j], indent));
          }
          if (closing.content) normalized.push(`${indent}${closing.content}`);
          normalized.push(`${indent}$$`);
          index = closing.index;
          continue;
        }
        normalized.push(escapeUnmatchedDisplayMathOpen(line));
        continue;
      }
    }

    // Bare `$$` opener (possibly indented inside a GFM list item). Two problems
    // need fixing: (1) when the closing `$$` is glued to the last content line
    // (e.g. `z = w$$`) remark-math never finds a valid closing fence and swallows
    // the rest of the document; (2) inside a list item, content lines at column 0
    // are lazy continuations that break the math flow. Both are fixed by moving
    // the closing `$$` to its own line and re-indenting lazy content lines.
    // A column-0 block with a properly detached closing `$$` is left untouched
    // (remark-math already parses it correctly).
    const displayMathBareOpen = line.match(/^([ \t]*)\$\$\s*$/);
    if (displayMathBareOpen) {
      const indent = displayMathBareOpen[1];
      const closing = findDisplayMathClose(
        lines,
        index + 1,
        indent,
        unmatchedDisplayMathUntil,
      );
      if (closing && (closing.glued || indent !== "")) {
        normalized.push(`${indent}$$`);
        for (let j = index + 1; j < closing.index; j++) {
          normalized.push(indentDisplayMathContent(lines[j], indent));
        }
        if (closing.content) normalized.push(`${indent}${closing.content}`);
        normalized.push(`${indent}$$`);
        index = closing.index;
        continue;
      }
      if (closing) {
        untouchedCloseAt.add(closing.index);
        normalized.push(line);
        continue;
      }
      normalized.push(escapeUnmatchedDisplayMathOpen(line));
      continue;
    }

    normalized.push(normalizeInlineLine(line));
  }

  return normalized.join(lineBreak);
}

interface DisplayMathClose {
  index: number;
  content: string;
  glued: boolean;
}

function findDisplayMathClose(
  lines: string[],
  startIndex: number,
  indent: string,
  unmatchedUntil: Map<string, number>,
): DisplayMathClose | null {
  const knownUnmatchedUntil = unmatchedUntil.get(indent);
  if (knownUnmatchedUntil !== undefined && startIndex < knownUnmatchedUntil) return null;

  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (isDisplayMathFence(line, indent)) return { index, content: "", glued: false };

    // A new Markdown block cannot belong to the preceding formula. In particular,
    // do not let a later sibling list item provide a closing `$$` for this block.
    if (
      isDisplayMathBlockBoundary(line, lines[index - 1], indent) ||
      isDisplayMathOpeningLine(line)
    ) {
      unmatchedUntil.set(indent, index);
      return null;
    }

    const content = getDisplayMathGluedCloseContent(line, indent);
    if (content !== null) return { index, content, glued: true };
  }

  // Multiple unmatched glued openers with the same indentation previously each
  // scanned to EOF. Cache this range so the overall search remains linear.
  unmatchedUntil.set(indent, lines.length);
  return null;
}

function escapeUnmatchedDisplayMathOpen(line: string): string {
  return line.replace(/^([ \t]*)\$\$/, (_match, indent: string) => `${indent}\\$\\$`);
}

function lineAfterMathIndent(line: string, indent: string): string | null {
  if (line.startsWith(indent)) return line.slice(indent.length);
  const whitespace = line.match(/^[ \t]*/)?.[0] ?? "";
  if (indent && whitespace.length < indent.length) return line.slice(whitespace.length);
  return null;
}

function isDisplayMathFence(line: string, indent: string): boolean {
  if (indent === "") return /^ {0,3}\$\$\s*$/.test(line);
  const rest = lineAfterMathIndent(line, indent);
  return rest !== null && /^\$\$\s*$/.test(rest);
}

function getDisplayMathGluedCloseContent(line: string, indent: string): string | null {
  const rest = lineAfterMathIndent(line, indent);
  if (rest === null) return null;

  const match = rest.match(/^(.+?)\$\$\s*$/);
  if (!match) return null;

  const content = match[1].trimEnd();
  return content && !content.includes("$$") ? content : null;
}

function isDisplayMathOpeningLine(line: string): boolean {
  return /^[ \t]*\$\$(?:\S|[ \t]+\S)/.test(line);
}

function isDisplayMathBlockBoundary(line: string, previous: string, indent: string): boolean {
  if (
    /^ {0,3}(`{3,}|~{3,})/.test(line) ||
    /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line) ||
    /<(code|pre|script|style)\b/i.test(line)
  ) {
    return true;
  }

  // Pretty-printed formulas put `-`/`+` on their own line, start a line with
  // `- \beta`, or with `>0` inside cases. Such a line only starts a list item or
  // blockquote when it leaves the formula's container (a sibling list item) or
  // follows a blank line.
  if (!/^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\S|^ {0,3}>/.test(line)) return false;
  return (line.match(/^[ \t]*/)?.[0].length ?? 0) < indent.length || previous.trim() === "";
}

function indentDisplayMathContent(line: string, indent: string): string {
  if (!indent || !line || line.startsWith("\t")) return line;

  const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
  if (leadingSpaces >= indent.length) return line;
  return `${indent.slice(leadingSpaces)}${line}`;
}

function findBracketDisplayClose(lines: string[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (/^ {0,3}\\\][ \t]*$/.test(line)) return index;

    // Do not pair delimiters across another Markdown block boundary.
    if (
      /^ {0,3}(`{3,}|~{3,})/.test(line) ||
      /^ {0,3}\\\[[ \t]*$/.test(line) ||
      /<(code|pre|script|style)\b/i.test(line)
    ) {
      return -1;
    }
  }

  return -1;
}

function updateInlineCodeMarker(line: string, initialMarkerSize: number): number {
  let markerSize = initialMarkerSize;
  for (let cursor = 0; cursor < line.length;) {
    if (line[cursor] !== "`") {
      cursor++;
      continue;
    }

    let end = cursor + 1;
    while (line[end] === "`") end++;
    const runSize = end - cursor;
    if (markerSize === 0) markerSize = runSize;
    else if (runSize === markerSize) markerSize = 0;
    cursor = end;
  }
  return markerSize;
}

function normalizeInlineLine(line: string): string {
  return escapeTableMathPipes(normalizeInlineLatexMath(line));
}

// Swap complete code spans for placeholders so their `$`, `|` and `\(` stay verbatim.
function normalizeInlineLineOutsideCode(line: string): string {
  if (line.includes("\uE000")) return line;
  const spans: string[] = [];
  const masked = line.replace(/(`+)[^`][\s\S]*?(?<!`)\1(?!`)/g, (span) => `\uE000${spans.push(span) - 1}\uE000`);
  return normalizeInlineLine(masked).replace(/\uE000(\d+)\uE000/g, (_match, index: string) => spans[Number(index)]);
}

function normalizeInlineLatexMath(line: string): string {
  if (
    /^\s{0,3}\[[^\]]+\]:/.test(line) ||
    /]\s*\(/.test(line) ||
    /<(?:!--|\/?[A-Za-z][^>]*>)/.test(line) ||
    /\b(?:https?|file|mailto):/i.test(line) ||
    /\b[A-Za-z]:\\/.test(line)
  ) {
    return line;
  }

  // `\$` (a literal dollar inside TeX) would close single-dollar math early, so
  // such formulas use `$$`, which remark-math also renders inline mid-line.
  // The same for `$...\$...$`; a TeX command or a tight `$\$25,000$` tells it from prose prices like `$5 or \$6 $`.
  return line.replace(
    /(?<!\\)\\\(((?:\\\$|[^`\r\n$])+?)(?<!\\)\\\)/g,
    (match, math: string) => (!math.trim() ? match : math.includes("$") ? `$$${math}$$` : `$${math}$`),
  ).replace(
    /(?<![\\$])\$(?!\$)((?:\\\$|[^$\r\n])*?\\\$(?:\\\$|[^$\r\n])*?)(?<!\\)\$(?!\$)/g,
    (match, math: string) => (isLikelyMathExpression(math) || /^\\\$.*\S$/.test(math) ? `$$${math}$$` : match),
  );
}

// GFM splits table cells on `|` before inline math is parsed, so `$|x|$` in a
// row breaks the column count and the whole table renders as a paragraph.
// `\|` would survive the split but means `‖` in TeX; `\vert` renders as `|`.
// Price/prose pairs are not math: skip them exactly as remarkCurrencySafeMath
// will, and retry from their closing `$`.
function escapeTableMathPipes(line: string): string {
  if (!/^ {0,3}\|/.test(line)) return line;
  const pair = /(?<![\\$])\$(?!\$)(\S(?:[^$\n]*?\S)?)(?<![\\$])\$(?!\$)/g;
  let output = "";
  let copied = 0;
  for (let match; (match = pair.exec(line));) {
    const end = match.index + match[0].length;
    // Retrying from the closing `$` is safe here: the pair regex needs non-space right after
    // an opening `$`, so a prose pair's closer can only open again when it is really `$NAME`.
    if (isPriceNotMath(match[1], line[end]) || isProseMathText(match[1])) {
      pair.lastIndex = end - 1;
      continue;
    }
    output += `${line.slice(copied, match.index)}$${match[1].replace(/(?<!\\)\|/g, "\\vert ")}$`;
    copied = end;
  }
  return output + line.slice(copied);
}

// `content` is between single `$`s; `next` is the character after the closing `$`.
function isPriceNotMath(content: string, next: string | undefined): boolean {
  const startsWithAmount = /^\s*[+-]?(?:\d|\.\d)/.test(content);
  const closesBeforeNumber = next !== undefined && /^[0-9]$/.test(next);
  const mismatchedPadding = /^\s/.test(content) !== /\s$/.test(content);
  return startsWithAmount && (closesBeforeNumber || mismatchedPadding);
}

function isLikelyMathExpression(value: string): boolean {
  return /\\[A-Za-z]+/.test(value) && !/\b(?:https?|file|mailto):|\b[A-Za-z]:\\|^\\\\/i.test(value);
}

// Parse YAML frontmatter into a `yaml` node before the math/GFM plugins run, so
// the raw metadata never leaks into the rendered output (without it, the opening
// `---` becomes an <hr> and the closing `---` turns the YAML into a setext heading).
// singleTilde:false requires ~~double~~ tildes for strikethrough. A single `~`
// is the standard CJK numeric-range separator (e.g. "5~7U", "100~200倍"), and
// GFM's default single-tilde strikethrough silently mangled such ranges (#385).
const remarkGfmOptions = { singleTilde: false } as const;

const cjkPunctuationPattern =
  /[\u3001\u3002\u3008-\u3011\u3014-\u301B\uFF01\uFF08\uFF09\uFF0C\uFF1A\uFF1B\uFF1F\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00B7\uFF5E\u301C]/;

// Only bare GFM autolinks have source equal to their label; explicit links
// (including URLs with punctuation) and genuine CJK paths stay untouched.
export function splitAutolinkLiteralsAtCjkPunctuation(tree: Root, source: string): void {
  const walk = (node: Root | Parent): void => {
    const children = node.children as Content[];
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child.type === "link") splitAutolinkLiteral(children, index, child, source);
      const current = children[index];
      if ("children" in current && Array.isArray(current.children)) walk(current as Parent);
    }
  };
  walk(tree);
}

function splitAutolinkLiteral(siblings: Content[], index: number, node: Link, source: string): void {
  if (node.title != null || node.children.length !== 1) return;
  const textNode = node.children[0];
  if (textNode.type !== "text") return;
  const start = node.position?.start;
  const end = node.position?.end;
  if (start?.offset == null || end?.offset == null) return;
  if (source.slice(start.offset, end.offset) !== textNode.value) return;
  const text = textNode.value;
  const cut = text.search(cjkPunctuationPattern);
  if (cut <= 0 || !node.url.endsWith(text)) return;
  const head = text.slice(0, cut);
  const boundary = { line: start.line, column: start.column + cut, offset: start.offset + cut };
  node.url = node.url.slice(0, node.url.length - text.length) + head;
  textNode.value = head;
  node.position = { start, end: boundary };
  siblings.splice(index + 1, 0, { type: "text", value: text.slice(cut), position: { start: boundary, end } });
}

function remarkSplitAutolinkLiterals() {
  return (tree: Root, file: { value?: unknown }): void => {
    splitAutolinkLiteralsAtCjkPunctuation(tree, typeof file.value === "string" ? file.value : "");
  };
}

function remarkDriveFileLinks() {
  const walk = (node: Root | Content): void => {
    if ((node.type === "link" || node.type === "definition") && /^\/?[a-z]:\//i.test(node.url)) {
      node.url = `file:///${node.url.replace(/^\//, "")}`;
    }
    if ("children" in node) node.children.forEach(walk);
  };
  return walk;
}

// Guard at tokenization, before ambiguous price/prose pairs swallow Markdown
// or a later formula's opening dollar. Register remark-math only once here.
// Keep remark-math's own tokenizer and resolver for real math, code and $$.
const closedProseDollars = new WeakMap<object, Set<number>>();

const remarkCurrencySafeMath: Plugin = function () {
  remarkMath.call(this);
  const data = this.data() as { micromarkExtensions?: Extension[] };
  const constructs = data.micromarkExtensions?.at(-1)?.text?.[36];
  for (const construct of Array.isArray(constructs) ? constructs : constructs ? [constructs] : []) {
    if (construct.name !== "mathText") continue;
    const tokenize = construct.tokenize;
    construct.tokenize = function (effects, ok, nok) {
      const start = this.now();
      const closedProse = closedProseDollars.get(this.parser);
      if (closedProse?.has(start.offset)) return nok;
      return tokenize.call(this, effects, (code) => {
        const end = this.now();
        const source = this.sliceSerialize({ start, end });
        if (source.startsWith("$") && !source.startsWith("$$")) {
          const next = code !== null && code >= 0 ? String.fromCodePoint(code) : undefined;
          const content = source.slice(1, -1);
          if (isPriceNotMath(content, next)) return nok(code);
          if (isProseMathText(content)) {
            // A pair written tight (`$模型输出$`, `$HOME$`) closes itself: its closing `$` must not
            // open the next formula. A trailing space means it was a stray opener (`$HOME 和 $x$`).
            if (!/\s$/.test(content)) {
              if (!closedProseDollars.has(this.parser)) closedProseDollars.set(this.parser, new Set());
              closedProseDollars.get(this.parser)!.add(end.offset - 1);
            }
            return nok(code);
          }
        }
        return ok(code);
      }, nok);
    };
  }
};

// CommonMark only closes `**` before whitespace or ASCII punctuation, so a Chinese
// run written as `**第一，节奏坏了。**Q2 证明…` rendered as literal asterisks: the
// closing `**` sits after a CJK punctuation mark. This plugin (CommonMark issue #650)
// accepts CJK punctuation as an emphasis boundary. Strikethrough is untouched.
export const markdownRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  [remarkFrontmatter, ["yaml"]],
  [remarkGfm, remarkGfmOptions],
  remarkDriveFileLinks,
  remarkSplitAutolinkLiterals,
  remarkCurrencySafeMath,
  remarkCjkFriendly,
];

// Bare custom <br> nodes avoid remark-rehype's extra newline after hard breaks
// (which pre-wrap would display twice). Code/math/html values stay untouched.
interface MarkdownTreeNode {
  type: string;
  value?: string;
  children?: MarkdownTreeNode[];
  data?: { hName?: string };
}
const LINE_ENDING = /[ \t]*(?:\r\n|\r|\n)[ \t]*/;
const HTML_BLOCK_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);
function literalUserHtml(parent: MarkdownTreeNode): void {
  if (!parent.children) return;
  parent.children = parent.children.map((node) => {
    if (node.type !== "html") {
      literalUserHtml(node);
      return node;
    }
    const text = { type: "text", value: node.value };
    return HTML_BLOCK_PARENTS.has(parent.type) ? { type: "paragraph", children: [text] } : text;
  });
}
function remarkLiteralUserHtml() {
  return (tree: MarkdownTreeNode) => literalUserHtml(tree);
}
function lineBreakNode(): MarkdownTreeNode {
  return { type: "lineBreak", data: { hName: "br" } };
}
function keepLineBreaks(parent: MarkdownTreeNode): void {
  if (!parent.children) return;
  parent.children = parent.children.flatMap((node) => {
    if (node.type === "break") return [lineBreakNode()];
    if (node.type !== "text" || !node.value) {
      keepLineBreaks(node);
      return [node];
    }
    return node.value.split(LINE_ENDING).flatMap((line, index) => [
      ...(index > 0 ? [lineBreakNode()] : []),
      ...(line ? [{ type: "text", value: line }] : []),
    ]);
  });
}
function remarkKeepLineBreaks() {
  return (tree: MarkdownTreeNode) => keepLineBreaks(tree);
}
export const markdownUserRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  ...(markdownRemarkPlugins ?? []),
  remarkLiteralUserHtml,
  remarkKeepLineBreaks,
];
export const markdownPreviewRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  [remarkFrontmatter, ["yaml"]],
  [remarkGfm, remarkGfmOptions],
  remarkDriveFileLinks,
  remarkSplitAutolinkLiterals,
  remarkCurrencySafeMath,
  remarkCjkFriendly,
];

function hastText(node: HastContent): string {
  return node.type === "text" ? node.value : node.type === "element" ? node.children.map(hastText).join("") : "";
}

// After sanitizing: user HTML cannot forge the internal source attribute.
function rehypeDisplayMathSource() {
  return (tree: HastRoot): void => {
    const visit = (parent: HastRoot | HastElement): void => {
      parent.children = parent.children.map((child) => {
        if (child.type !== "element") return child;
        const code = child.tagName === "pre" && child.children.length === 1 ? child.children[0] : null;
        const classes = code?.type === "element" && code.tagName === "code" ? code.properties.className : null;
        if (Array.isArray(classes) && classes.includes("language-math")) {
          return {
            type: "element",
            tagName: "div",
            properties: { dataMathSource: hastText(child).replace(/\n$/, "") },
            children: [child],
          };
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}

export const markdownRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  rehypeDisplayMathSource,
  [rehypeKatex, { throwOnError: false, strict: false }],
];

export const markdownPreviewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [rehypeKatex, { throwOnError: false, strict: false }],
];
