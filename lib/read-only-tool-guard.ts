import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WRITE_CAPABLE_TOOLS = ["bash", "powershell", "edit", "write"];

/** The read-only preset: no write-capable built-in is active. */
export function hasWriteCapableTool(activeTools: readonly string[]): boolean {
  return activeTools.some((name) => WRITE_CAPABLE_TOOLS.includes(name));
}

/**
 * A session with no write-capable built-in active (the read-only preset) must not
 * change things through MCP either. MCP tools stay callable from codemode and
 * tool_search whatever the active set, so every MCP tool call is blocked here
 * (nested codemode calls pass this hook too). A server's `readOnlyHint` is not
 * trusted: pi does not verify it, so a server could mark any tool read-only.
 * pi's own resource tools (list/read_mcp_resource) only read and stay allowed.
 */
export function readOnlyToolGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (!event.toolName.startsWith("mcp__")) return;
    if (hasWriteCapableTool(pi.getActiveTools())) return;
    return {
      block: true,
      reason: `${event.toolName} is an MCP tool, and this session uses read-only tools.`,
    };
  });
}
