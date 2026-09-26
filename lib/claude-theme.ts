// Colors for the Claude theme that must be concrete values rather than CSS
// variables: Prism styles are passed as objects and Mermaid derives shades
// from hex in JS. Keep them in step with app/theme-claude.css.
import type { CSSProperties } from "react";
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";

type PrismStyle = Record<string, CSSProperties>;

// Warm recoloring of Prism `vs`: clay keywords, olive strings, amber literals,
// muted teal types. Every token clears 4.5:1 on --bg except comments (~4:1).
const TOKEN_COLORS: Record<string, string> = {
  comment: "#7d7b73", prolog: "#7d7b73", doctype: "#7d7b73", cdata: "#7d7b73",
  punctuation: "#3d3d3a", operator: "#3d3d3a", function: "#3d3d3a",
  string: "#5b7a3a", inserted: "#5b7a3a",
  keyword: "#a8472a", atrule: "#a8472a", tag: "#a8472a", selector: "#a8472a",
  ".language-autohotkey .token.keyword": "#a8472a",
  number: "#946010", boolean: "#946010", constant: "#946010", symbol: "#946010",
  variable: "#946010", url: "#946010", "attr-name": "#946010",
  ".language-json .token.boolean": "#946010", ".language-json .token.number": "#946010",
  "class-name": "#2e6e66", property: "#2e6e66", "attr-value": "#5b7a3a",
  ".language-json .token.property": "#2e6e66", "code[class*=\"language-css\"]": "#2e6e66",
  regex: "#b53333", entity: "#b53333", deleted: "#b53333", ".language-autohotkey .token.tag": "#b53333",
};

export const claudeCodeStyle: PrismStyle = Object.fromEntries(
  Object.entries(vs as PrismStyle).map(([key, value]) => {
    if (key in TOKEN_COLORS) return [key, { ...value, color: TOKEN_COLORS[key] }];
    if (key.includes("::selection") || key.includes("::-moz-selection")) return [key, { background: "#f0dcd3" }];
    if (value.color === "#393A34") return [key, { ...value, color: "#3d3d3a" }];
    return [key, value];
  }),
);

// Warm recoloring of Prism `vscDarkPlus`, mapped color by color so every
// language-specific rule follows: clay keywords, olive strings, amber
// literals, sand functions, muted teal types; identifiers (VS Code's light
// blue) fall back to the base ink to keep dense code calm.
const DARK_COLORS: Record<string, string> = {
  "#d4d4d4": "#dedcd4", "#9cdcfe": "#dedcd4",
  "#569cd6": "#e08a6d", "#c586c0": "#e08a6d", "#db4c69": "#e08a6d",
  "#ce9178": "#b3c78f", "#b5cea8": "#e0b36a", "#d7ba7d": "#e0b36a",
  "#dcdcaa": "#e6d3a3", "#4ec9b0": "#7fb8ad", "#d16969": "#e86b6b",
  "#6a9955": "#8d8b85", "#808080": "#8d8b85",
  "#1e1e1e": "#1a1a19", "#264f78": "#5a3a2e",
};

export const claudeDarkCodeStyle: PrismStyle = Object.fromEntries(
  Object.entries(vscDarkPlus as PrismStyle).map(([key, value]) => [
    key,
    Object.fromEntries(Object.entries(value).map(([prop, v]) => [
      prop,
      typeof v === "string" ? v.replace(/#[0-9a-f]{6}\b/gi, (c) => DARK_COLORS[c.toLowerCase()] ?? c) : v,
    ])),
  ]),
);

export const claudeMermaidVariables = {
  background: "#fdfdf7",
  primaryColor: "#efefe9",
  primaryTextColor: "#141413",
  primaryBorderColor: "#b9b9b3",
  secondaryColor: "#f4e6df",
  tertiaryColor: "#f6f6f0",
  lineColor: "#73736d",
  noteBkgColor: "#f7efe0",
  noteBorderColor: "#d9c7a3",
};

export const claudeDarkMermaidVariables = {
  darkMode: true,
  background: "#151515",
  primaryColor: "#262625",
  primaryTextColor: "#f8f7f4",
  primaryBorderColor: "#4a4947",
  secondaryColor: "#3a2b25",
  tertiaryColor: "#1f1f1e",
  lineColor: "#8d8b85",
  edgeLabelBackground: "#151515",
  textColor: "#f8f7f4",
  noteBkgColor: "#33291c",
  noteBorderColor: "#6b5a3a",
  noteTextColor: "#f8f7f4",
};
