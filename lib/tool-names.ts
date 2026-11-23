/**
 * Tool-name predicates shared by the chat views.
 *
 * Pi's built-in names are plain `write` / `edit`, but MCP servers expose the
 * same operations under prefixed or namespaced names, so each predicate also
 * accepts the common decorated forms.
 */

export function isWriteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" ||
    name.startsWith("write_") ||
    name.endsWith(".write") ||
    name.endsWith("_write");
}

export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}

/**
 * Codex-style patch tools write files too, and their input is the patch itself
 * rather than a `file_path` argument, so callers must read the patch instead.
 * Matches the bare name and the common MCP-decorated forms.
 */
export function isApplyPatchToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "apply_patch" ||
    name.endsWith(".apply_patch") ||
    name.endsWith("/apply_patch") ||
    name.endsWith("_apply_patch");
}

/** Pi names MCP tools `mcp__<server>__<tool>`; show them as `server/tool` like the TUI. */
export function displayToolName(toolName: string): string {
  const match = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(toolName);
  return match ? `${match[1]}/${match[2]}` : toolName;
}

const MIRRORED_BUILTINS = new Set(["bash", "read", "edit", "write"]);
// ACP tool kinds → the closest built-in glyph (ToolIcon matches "search"/"fetch" itself).
const ACP_KIND_AS: Record<string, string> = { read: "read", edit: "edit", delete: "edit", move: "edit", search: "search", fetch: "fetch", execute: "bash" };

export interface ToolPresentation {
  label: string;
  /** Namespace shown as a tag, e.g. the agent a bridge extension replays. */
  source?: string;
  /** Name to pick the icon and activity category by: the built-in it stands for, else the tool name. */
  as: string;
}

/**
 * Bridge extensions replay another agent's actions as `<source>_<builtin>` tools with the
 * built-in's arguments (pi forbids reusing a built-in name): show those as the built-in,
 * tagged with the source. A `<source>_tool` catch-all shows its `title`; an ACP `kind` picks the icon.
 */
export function toolPresentation(toolName: string, input?: Record<string, unknown>): ToolPresentation {
  const match = /^([a-z][a-z0-9]*)_([a-z]+)$/.exec(toolName);
  if (match && MIRRORED_BUILTINS.has(match[2])) return { label: match[2], source: match[1], as: match[2] };
  if (match?.[2] === "tool" && typeof input?.title === "string" && input.title.trim()) {
    return { label: input.title, source: match[1], as: ACP_KIND_AS[String(input.kind)] ?? toolName };
  }
  return { label: displayToolName(toolName), as: toolName };
}
