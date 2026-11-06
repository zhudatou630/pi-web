/**
 * Whether `codemode` is offered to the model by default: pi's own `defaultTools`, the same
 * setting as `"defaultTools": ["+codemode"]` (`pi --tools +codemode`), so the pi CLI agrees.
 * Global `~/.pi/agent/settings.json`; per project `<cwd>/.pi/settings.json`, whose `+`/`-`
 * list modifies the global selection (pi's mergeDefaultTools). Pi still enables codemode
 * on its own when an MCP server with codemode exposure connects.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, hasTrustRequiringProjectResources } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import type { ProjectFeatureState } from "./api-types";
import { configuredTools, DEFAULT_TOOLS, isToolModifier, parseSettings, resolveDefaultTools } from "./powershell-settings";
import { ProjectNotTrustedError } from "./project-resource-overrides";
import { assertAutoTrustable, getProjectTrustStatus, trustProjectAutomatically } from "./project-trust";

const CODEMODE = "codemode";
type Tools = string[] | undefined;

/** pi's mergeDefaultTools: a `+`/`-` list appends to the inherited one, a plain list replaces it. */
function merge(base: Tools, overrides: Tools): Tools {
  if (overrides === undefined) return base;
  if (base === undefined || !overrides.every(isToolModifier)) return overrides;
  return [...base, ...overrides];
}

function codemodeIn(tools: Tools): boolean {
  return (tools === undefined ? DEFAULT_TOOLS : resolveDefaultTools(tools)).includes(CODEMODE);
}

/**
 * Whether this layer must be written as a plain list: it replaces the inherited selection, or the
 * inherited list is `[]`, which a `+`/`-` layer would turn back into pi's defaults.
 * (`[]` over an inherited list inherits it.)
 */
const needsPlain = (entries: Tools, base: Tools) => base?.length === 0
  || (entries !== undefined && (entries.some((entry) => !isToolModifier(entry)) || (entries.length === 0 && base === undefined)));

/**
 * One settings layer (`entries` over `base`) with codemode effectively `enabled`.
 * A `+`/`-` layer drops its own codemode entries first, so matching `base` follows it again,
 * and is removed when left empty. A replacing layer is rewritten as the plain list it resolves to.
 */
export function withCodemode(entries: Tools, base: Tools, enabled: boolean): Tools {
  if (needsPlain(entries, base)) {
    const tools = resolveDefaultTools(merge(base, entries) ?? []).filter((name) => name !== CODEMODE);
    if (enabled) tools.push(CODEMODE);
    // `[]` here would inherit `base` instead of meaning no tools.
    if (tools.length === 0 && base !== undefined) throw new Error("This project's defaultTools would be empty; edit .pi/settings.json directly");
    return tools;
  }
  const kept = (entries ?? []).filter((entry) => entry.slice(1) !== CODEMODE);
  const layer = kept.length > 0 ? kept : undefined;
  if (codemodeIn(merge(base, layer)) === enabled) return layer;
  return [...kept, `${enabled ? "+" : "-"}${CODEMODE}`];
}

const globalPath = (agentDir: string) => join(agentDir, "settings.json");
const projectPath = (cwd: string) => join(cwd, CONFIG_DIR_NAME, "settings.json");
const readTools = (path: string): Tools => (existsSync(path) ? configuredTools(parseSettings(path)) : undefined);

/** The global default and, with a cwd, what applies there (pi ignores an untrusted project's settings). */
export function readCodemodeState(agentDir: string, cwd?: string | null): { enabled: boolean; project?: ProjectFeatureState } {
  const global = readTools(globalPath(agentDir));
  const enabled = codemodeIn(global);
  if (!cwd) return { enabled };
  const project = getProjectTrustStatus(cwd, agentDir).trusted ? readTools(projectPath(cwd)) : undefined;
  const here = codemodeIn(merge(global, project));
  return { enabled, project: { root: cwd, enabled: here, overridden: here !== enabled } };
}

/** Same lock as pi's settings storage; other keys are kept. */
async function updateDefaultTools(path: string, update: (tools: Tools) => Tools): Promise<void> {
  if (!existsSync(path)) {
    if (update(undefined) === undefined) return;
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, "{}", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const release = await lockfile.lock(path, { realpath: false, retries: 10 });
  try {
    const settings = parseSettings(path);
    const next = update(configuredTools(settings));
    if (next === undefined) delete settings.defaultTools;
    else settings.defaultTools = next;
    writeFileSync(path, JSON.stringify(settings, null, 2), "utf8");
  } finally {
    await release();
  }
}

export function writeGlobalCodemode(agentDir: string, enabled: boolean): Promise<void> {
  return updateDefaultTools(globalPath(agentDir), (tools) => withCodemode(tools, undefined, enabled));
}

/** Like setProjectOverrides: trust-gated, and records trust for settings the user just authored. */
export async function writeProjectCodemode(cwd: string, agentDir: string, enabled: boolean): Promise<void> {
  const trust = getProjectTrustStatus(cwd, agentDir);
  if (!trust.trusted) throw new ProjectNotTrustedError("Project resources must be trusted before changing project settings");
  if (!trust.requiresTrust) await assertAutoTrustable(cwd, (message) => new ProjectNotTrustedError(message), agentDir);
  const global = readTools(globalPath(agentDir));
  await updateDefaultTools(projectPath(cwd), (tools) => withCodemode(tools, global, enabled));
  if (!trust.requiresTrust && hasTrustRequiringProjectResources(cwd)) trustProjectAutomatically(cwd, agentDir);
}
