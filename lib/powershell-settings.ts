import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { SETTINGS_BUILTIN_TOOLS } from "./tool-presets";

export const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const SHELL_TOOLS = new Set(["bash", "powershell"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPowerShellToolEnabled(
  defaultTools: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32"
    && defaultTools?.includes("powershell") === true
    && !defaultTools.includes("bash");
}

export function replaceShellTool(
  toolNames: readonly string[],
  usePowerShell: boolean,
): string[] {
  const shell = usePowerShell ? "powershell" : "bash";
  const result: string[] = [];
  for (const name of toolNames) {
    const next = SHELL_TOOLS.has(name) ? shell : name;
    if (!result.includes(next)) result.push(next);
  }
  return result;
}

export function resolveShellTools(
  toolNames: readonly string[],
  defaultTools: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return replaceShellTool(toolNames, isPowerShellToolEnabled(defaultTools, platform));
}

export function getPowerShellSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "settings.json");
}

export function parseSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    // pi strips a UTF-8 BOM before parsing.
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error instanceof SyntaxError) throw new SyntaxError(`${path}: ${error.message}`);
    throw error;
  }
  if (!isRecord(parsed)) throw new Error("Invalid settings.json: expected an object");
  return parsed;
}

export function configuredTools(settings: Record<string, unknown>): string[] | undefined {
  if (settings.defaultTools === undefined) return undefined;
  if (
    !Array.isArray(settings.defaultTools)
    || settings.defaultTools.some((name) => typeof name !== "string")
  ) {
    throw new Error("Invalid settings.json: defaultTools must be an array of strings");
  }
  return settings.defaultTools as string[];
}

export const isToolModifier = (entry: string) => entry.startsWith("+") || entry.startsWith("-");

/** Pi's `defaultTools` resolution (not exported by the SDK): `+name`/`-name` edit the defaults or the plain list. */
export function resolveDefaultTools(entries: readonly string[]): string[] {
  const plain = entries.filter((entry) => !isToolModifier(entry));
  const tools = plain.length > 0 || entries.length === 0 ? plain : [...DEFAULT_TOOLS];
  for (const entry of entries) {
    if (!isToolModifier(entry)) continue;
    const name = entry.slice(1);
    const index = tools.indexOf(name);
    if (entry.startsWith("+") && index === -1 && name) tools.push(name);
    else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
  }
  return tools;
}

export function builtinToolsOf(entries: readonly string[] | undefined, platform: NodeJS.Platform = process.platform): string[] {
  const tools = entries === undefined ? DEFAULT_TOOLS : resolveDefaultTools(entries);
  return SETTINGS_BUILTIN_TOOLS.filter((name) => tools.includes(name)
    || (name === "bash" && platform === "win32" && tools.includes("powershell")));
}

/** Edit only built-ins; retain other entries and the order of carried tools. */
export function withBuiltinTools(entries: readonly string[] | undefined, selected: readonly string[], platform: NodeJS.Platform = process.platform): string[] | undefined {
  const current = entries === undefined ? DEFAULT_TOOLS : resolveDefaultTools(entries);
  const shell = isPowerShellToolEnabled(current, platform) ? "powershell" : "bash";
  const managed = new Set([...SETTINGS_BUILTIN_TOOLS, ...(platform === "win32" ? ["powershell"] : [])]);
  const wanted = new Set(selected.map((name) => name === "bash" ? shell : name));
  const same = [...managed].every((name) => current.includes(name) === wanted.has(name));
  if (same) return entries && [...entries];
  const changed = new Set([...managed].filter((name) => current.includes(name) !== wanted.has(name)));
  const next = (entries ?? []).filter((entry) => !changed.has(isToolModifier(entry) ? entry.slice(1) : entry));
  // A modifier-only list starts from pi's defaults, even when the last plain tool was removed.
  const base = next.length ? resolveDefaultTools(next) : DEFAULT_TOOLS;
  for (const name of managed) {
    if (base.includes(name) !== wanted.has(name)) next.push(`${wanted.has(name) ? "+" : "-"}${name}`);
  }
  return next.length ? next : undefined;
}

export async function readToolSettings(
  settingsPath = getPowerShellSettingsPath(),
  platform: NodeJS.Platform = process.platform,
) {
  let raw: string[] | undefined;
  if (existsSync(settingsPath)) {
    const release = await lockfile.lock(settingsPath, { realpath: false, retries: 10 });
    try { raw = configuredTools(parseSettings(settingsPath)); } finally { await release(); }
  }
  return { isWindows: platform === "win32", powerShellEnabled: isPowerShellToolEnabled(raw && resolveDefaultTools(raw), platform), builtinTools: builtinToolsOf(raw, platform) };
}

export async function readPowerShellToolEnabled(
  settingsPath = getPowerShellSettingsPath(),
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  return (await readToolSettings(settingsPath, platform)).powerShellEnabled;
}

async function updateToolSettings(settingsPath: string, update: (settings: Record<string, unknown>) => void) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  try {
    writeFileSync(settingsPath, "{}", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const release = await lockfile.lock(settingsPath, { realpath: false, retries: 10 });
  try {
    const settings = parseSettings(settingsPath);
    update(settings);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    chmodSync(settingsPath, 0o600);
  } finally {
    await release();
  }
}

export async function writeBuiltinTools(selected: readonly string[], settingsPath = getPowerShellSettingsPath(), platform: NodeJS.Platform = process.platform): Promise<void> {
  await updateToolSettings(settingsPath, (settings) => {
    const next = withBuiltinTools(configuredTools(settings), selected, platform);
    if (next === undefined) delete settings.defaultTools;
    else settings.defaultTools = next;
  });
}

export async function writePowerShellToolEnabled(
  enabled: boolean,
  settingsPath = getPowerShellSettingsPath(),
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== "win32") throw new Error("PowerShell tool settings are only available on Windows");

  await updateToolSettings(settingsPath, (settings) => {
    const raw = configuredTools(settings);
    if (raw?.length && raw.every(isToolModifier)) {
      // Keep a delta-only list (e.g. ["+codemode"]) a delta, so later changes to pi's defaults still apply.
      settings.defaultTools = [
        ...raw.filter((entry) => !SHELL_TOOLS.has(entry.slice(1))),
        ...(enabled ? ["-bash", "+powershell"] : []),
      ];
    } else {
      const currentTools = raw ?? DEFAULT_TOOLS;
      const nextTools = replaceShellTool(currentTools, enabled);
      if (!currentTools.some((name) => SHELL_TOOLS.has(name))) {
        nextTools.push(enabled ? "powershell" : "bash");
      }
      settings.defaultTools = nextTools;
    }
  });
  return enabled;
}
