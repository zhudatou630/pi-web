export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  parameters?: Record<string, unknown>;
  promptGuidelines?: string[];
}

/**
 * The preset meaning "send no override at all": the session follows Pi's own
 * `defaultTools` from settings.json. It is the state of a user who never opened
 * the tool picker, so it must not be silently recorded as `default` (which pins
 * the session to Pi Web's four built-in tools and makes it disagree with the CLI).
 */
export const CONFIGURED_TOOL_PRESET = "configured" as const;

export const TOOL_PRESET_VALUES = [CONFIGURED_TOOL_PRESET, "none", "read-only", "default", "full"] as const;
export type ToolPreset = typeof TOOL_PRESET_VALUES[number];

/** Presets that name a concrete list of built-in tools. */
export type ConcreteToolPreset = Exclude<ToolPreset, typeof CONFIGURED_TOOL_PRESET>;

export function getToolNamesForPreset(preset: ToolPreset): string[] | undefined {
  if (preset === CONFIGURED_TOOL_PRESET) return undefined;
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "read-only") return [...PRESET_READ_ONLY];
  if (preset === "full") return [...PRESET_FULL];
  return [...PRESET_DEFAULT];
}

export const PRESET_NONE: string[] = [];
export const PRESET_READ_ONLY: string[] = ["read", "grep", "find", "ls"];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls"];

const BUILTIN_TOOL_NAMES = new Set([...PRESET_FULL, "powershell"]);

export function isToolPreset(value: unknown): value is ToolPreset {
  return typeof value === "string" && (TOOL_PRESET_VALUES as readonly string[]).includes(value);
}

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = tools.filter((t) => t.active);
  return getPresetFromToolNames(activeTools.map((tool) => tool.name));
}

/**
 * Reverse-map a resolved tool list to a concrete preset.
 *
 * Deliberately typed to exclude "configured": an unpinned session's loadout may
 * happen to match one of these lists, but borrowing that label would claim the
 * user had chosen it. Callers label unpinned sessions as configured instead.
 */
export function getConcretePresetFromToolNames(toolNames: readonly string[]): ConcreteToolPreset {
  if (toolNames.length === 0) return "none";

  const active = toolNames
    .map((name) => name === "powershell" ? "bash" : name)
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
    .sort()
    .join(",");

  if (active === [...PRESET_READ_ONLY].sort().join(",")) return "read-only";
  if (active === [...PRESET_DEFAULT].sort().join(",")) return "default";
  if (active === [...PRESET_FULL].sort().join(",")) return "full";
  return "default";
}

export function getPresetFromToolNames(toolNames: readonly string[]): ConcreteToolPreset {
  return getConcretePresetFromToolNames(toolNames);
}
