import type { ToolCallContent } from "./types";

function readable(value: unknown, separator = ", "): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object")) {
    return value.map((item) => readable(item)).filter(Boolean).join(separator) || null;
  }
  return null;
}

/** Header text, not serialization: bounded traversal also tolerates cyclic extension arguments. */
export function getToolPreview(block: ToolCallContent): { text: string; path?: string } {
  const input = block.input;
  if (!input || typeof input !== "object") return { text: "" };
  for (const key of ["command", "pattern", "query"]) {
    const text = readable(input[key], key === "command" ? " " : ", ");
    if (text) return { text: text.slice(0, 120) };
  }
  for (const key of ["path", "file_path"]) {
    const path = input[key];
    if (typeof path === "string" && path.trim()) return { text: path, path };
  }
  const values = Object.values(input);
  for (const value of values) {
    const text = readable(value);
    if (text) return { text: text.slice(0, 120) };
  }
  let budget = 100;
  const nested = (value: unknown, depth = 0): string => {
    if (--budget < 0 || depth > 8) return "";
    const text = readable(value);
    if (text !== null) return text.slice(0, 120);
    if (!value || typeof value !== "object") return "";
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => nested(item, depth + 1)).filter(Boolean).join(", ").slice(0, 120);
    for (const inner of Object.values(value)) {
      const text = nested(inner, depth + 1);
      if (text) return text;
    }
    return "";
  };
  return { text: nested(input) };
}
