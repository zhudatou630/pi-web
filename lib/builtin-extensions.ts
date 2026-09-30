import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/**
 * The CLI's built-in extensions that the SDK exports (`llama.cpp` is not). SDK sessions get
 * none of them by default. As `builtin: true` entries they are `builtin:<name>` resources:
 * `-builtin:<name>` in `extensions` and `--no-extensions` disable them, and `replaceable`
 * lets an installed extension that registers `/mcp` (pi-mcp-adapter) take over.
 */
export const BUILTIN_EXTENSION_NAMES = ["codemode", "tool-search", "mcp"] as const;

export const BUILTIN_EXTENSION_PREFIX = "builtin:";

export function createBuiltinExtensions(): InlineExtension[] {
  return [
    { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
    { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
    // The OAuth page must open in the user's browser, not on the server: the URL is
    // shown through ui.notify and the redirect URL is pasted back through ui.input.
    { name: "mcp", factory: createMcpExtension({ openUrl: () => {} }), replaceable: true, builtin: true },
  ];
}
