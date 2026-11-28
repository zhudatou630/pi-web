import type { CSSProperties } from "react";
import vs from "react-syntax-highlighter/dist/esm/styles/prism/vs";

// Light code colors for the file viewer and chat code blocks: Prism's `vs` keeps its layout rules,
// the token colors follow GitHub's current light palette (Primer) instead of Visual Studio 2008's
// pure blue/red/green. Plain text and punctuation take the app's text color; comments are not
// italic (the bundled mono font has no italic face, and state is never italic here, docs/ui.md).
const TEXT = "var(--text)";
const COMMENT = "#6e7781";
const KEYWORD = "#cf222e";
const STRING = "#0a3069";
const CONSTANT = "#0550ae";
const FUNCTION = "#8250df";
const ENTITY = "#953800";
const TAG = "#116329";

const color = (value: string): CSSProperties => ({ color: value });

export const lightCodeTheme: Record<string, CSSProperties> = {
  ...vs,
  'code[class*="language-"]': { ...vs['code[class*="language-"]'], color: TEXT },
  'pre[class*="language-"]': { ...vs['pre[class*="language-"]'], color: TEXT },
  comment: color(COMMENT),
  prolog: color(COMMENT),
  doctype: color(COMMENT),
  cdata: color(COMMENT),
  punctuation: color(TEXT),
  operator: color(TEXT),
  keyword: color(KEYWORD),
  atrule: color(KEYWORD),
  important: color(KEYWORD),
  selector: color(TAG),
  string: color(STRING),
  char: color(STRING),
  regex: color(STRING),
  url: color(STRING),
  "attr-value": color(STRING),
  number: color(CONSTANT),
  boolean: color(CONSTANT),
  constant: color(CONSTANT),
  symbol: color(CONSTANT),
  variable: color(ENTITY),
  property: color(CONSTANT),
  "attr-name": color(CONSTANT),
  entity: color(CONSTANT),
  function: color(FUNCTION),
  "class-name": color(ENTITY),
  builtin: color(ENTITY),
  tag: color(TAG),
  inserted: color(TAG),
  deleted: color("#82071e"),
  ".language-json .token.property": color(CONSTANT),
  ".language-json .token.boolean": color(CONSTANT),
  ".language-json .token.number": color(CONSTANT),
  'code[class*="language-css"]': color(TEXT),
  ".language-autohotkey .token.selector": color(KEYWORD),
  ".language-autohotkey .token.tag": color(TAG),
  ".language-autohotkey .token.keyword": color(KEYWORD),
  "directive.tag.tag": color(TEXT),
};
