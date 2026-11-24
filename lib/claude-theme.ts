// Colors for the Claude theme that must be concrete values rather than CSS
// variables: Prism styles are passed as objects and Mermaid derives shades
// from hex in JS. Keep them in step with app/theme-claude.css.
import type { CSSProperties } from "react";
import vs from "react-syntax-highlighter/dist/esm/styles/prism/vs";

type PrismStyle = Record<string, CSSProperties>;
type Role = "kw" | "fn" | "nm" | "ar" | "cm" | "pl" | "add" | "del";

// claude.dev's blog highlighting: few cool hues on prose-tier plain text.
// kw purple = keywords and literals, fn blue = functions and types,
// nm green = properties and names, ar cyan = strings and values,
// cm = caption gray, pl = --text-muted. Every other colored token is plain.
const ROLES: Record<string, Role> = {
  comment: "cm", prolog: "cm", doctype: "cm", cdata: "cm",
  keyword: "kw", atrule: "kw", boolean: "kw", number: "kw", important: "kw", tag: "kw", selector: "kw",
  ".language-autohotkey .token.keyword": "kw", ".language-autohotkey .token.selector": "kw",
  ".language-json .token.boolean": "kw", ".language-json .token.number": "kw",
  function: "fn", "class-name": "fn", builtin: "fn",
  property: "nm", "attr-name": "nm", constant: "nm", symbol: "nm", variable: "nm",
  ".language-json .token.property": "nm",
  string: "ar", char: "ar", "attr-value": "ar", url: "ar", regex: "ar", entity: "ar",
  inserted: "add", deleted: "del", ".language-autohotkey .token.tag": "del",
};

// Built on Prism `vs` for both modes so dark gets the same role map; selection
// and token backgrounds are dropped (the page's clay ::selection applies).
function paperCodeStyle(colors: Record<Role, string>): PrismStyle {
  return Object.fromEntries(
    Object.entries(vs as PrismStyle)
      .filter(([key]) => !key.includes("selection"))
      .map(([key, value]) => [key, { ...value, background: undefined, ...(value.color && { color: colors[ROLES[key] ?? "pl"] }) }]),
  );
}

// Each clears ~4.5:1 on the raised code panel.
export const claudeCodeStyle = paperCodeStyle({
  kw: "#914dbe", fn: "#3065d7", nm: "#567527", ar: "#16749a",
  cm: "#6b6a64", pl: "#45443e", add: "#3e7a3e", del: "#a04545",
});

// Same hues as light, desaturated to sit on warm charcoal (~6.5-8:1); Material's
// neon green (#c3e88d, 11:1) outshone the prose.
export const claudeDarkCodeStyle = paperCodeStyle({
  kw: "#c49be0", fn: "#8fb0f0", nm: "#a9c682", ar: "#7cc0d6",
  cm: "#979691", pl: "#b9b7b1", add: "#9ac29a", del: "#c29a9a",
});

// Diagrams sit on the raised code panel (--bg-raised): nodes are canvas-colored
// cards with ink-22% hairline borders, muted connectors, labels on the panel, no clay.
export const claudeMermaidVariables = {
  background: "#f1efe8",
  primaryColor: "#faf9f5",
  primaryTextColor: "#141413",
  primaryBorderColor: "#c7c6c3",
  secondaryColor: "#ece9e0",
  tertiaryColor: "#f7f6f2",
  lineColor: "#65645e",
  edgeLabelBackground: "#f1efe8",
  textColor: "#141413",
  noteBkgColor: "#ece9e0",
  noteBorderColor: "#c7c6c3",
};

export const claudeDarkMermaidVariables = {
  darkMode: true,
  background: "#252524",
  primaryColor: "#2e2e2c",
  primaryTextColor: "#e3e2de",
  primaryBorderColor: "#424241",
  secondaryColor: "#353533",
  tertiaryColor: "#252524",
  lineColor: "#979691",
  edgeLabelBackground: "#252524",
  textColor: "#e3e2de",
  noteBkgColor: "#2a2928",
  noteBorderColor: "#424241",
  noteTextColor: "#e3e2de",
};
