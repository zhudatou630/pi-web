import { DefaultPackageManager, type InlineExtension, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { BUILTIN_EXTENSION_PREFIX, createBuiltinExtensions } from "./builtin-extensions";
import { subagentUsesBuiltinExtensions } from "./subagents";

const CHILD_BUILTINS = ["mcp", "codemode", "tool-search"] as const;

/**
 * Resource-loader options that give a child pi's built-in MCP, codemode and tool_search extensions
 * when its profile names MCP servers or lists `codemode`/`tool_search`: the same factories as a main
 * session, MCP narrowed to the profile's servers and read from the parent's directory. They honor
 * `-builtin:<name>` in `extensions`. A child that loads extensions gets them through pi's own resolution;
 * one that does not gets the enabled ones as `-e builtin:<name>` paths (`pi --no-extensions -e builtin:mcp`).
 */
export async function subagentBuiltinExtensionOptions(
  resources: { tools: readonly string[]; loadExtensions: boolean; mcpServers?: readonly string[] },
  configCwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
): Promise<{ extensionFactories: InlineExtension[]; additionalExtensionPaths: string[] }> {
  if (!subagentUsesBuiltinExtensions(resources)) return { extensionFactories: [], additionalExtensionPaths: [] };
  const extensionFactories = await createBuiltinExtensions({ servers: resources.mcpServers ?? [], configCwd });
  if (resources.loadExtensions) return { extensionFactories, additionalExtensionPaths: [] };
  const resolved = await new DefaultPackageManager({ cwd: configCwd, agentDir, settingsManager, builtinExtensions: [...CHILD_BUILTINS] })
    .resolve(async () => "skip");
  const additionalExtensionPaths = CHILD_BUILTINS
    .map((name) => `${BUILTIN_EXTENSION_PREFIX}${name}`)
    .filter((path) => resolved.extensions.find((resource) => resource.path === path)?.enabled !== false);
  return { extensionFactories, additionalExtensionPaths };
}
