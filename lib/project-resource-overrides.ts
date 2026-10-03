/**
 * Per-project resource overrides ("inherit" / "load" / "unload"), ported from
 * pi's `pi config --local` selector (modes/interactive/components/config-selector.js,
 * which the SDK does not export). Keep the written settings shape identical so
 * pi-web and the pi TUI read and write the same `.pi/settings.json`:
 *
 * - package resources: a project entry `{ source, autoload: false, <type>: ["+path" | "-path"] }`,
 *   a delta over the global package that never installs a project copy;
 * - top-level resources (auto-discovered or settings paths): project `<type>` entries
 *   `[absPath, "+absPath" | "-absPath"]`.
 */
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  hasTrustRequiringProjectResources,
  SettingsManager,
  type PackageSource,
  type PathMetadata,
  type ResolvedPaths,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_EXTENSION_NAMES } from "./builtin-extensions";
import { assertAutoTrustable, getProjectTrustStatus, trustProject } from "./project-trust";
import { realPathOrSelf } from "./worktree";

export const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export type OverrideState = "inherit" | "load" | "unload";
type SettingsScope = "user" | "project";
type OnMissing = (source: string) => Promise<"skip" | "install" | "error">;

export interface ScopedResource {
  type: ResourceType;
  path: string;
  /** Effective for this cwd. */
  enabled: boolean;
  metadata: PathMetadata;
  /** Global metadata when the resource is inherited from global config, else `metadata`. */
  owner: PathMetadata;
  /** null: the resource does not exist in global config (project-only). */
  globalEnabled: boolean | null;
  override: OverrideState;
  /** false: a hand-written project entry that per-item writes cannot change. */
  editable: boolean;
}

interface Item {
  type: ResourceType;
  path: string;
  enabled: boolean;
  metadata: PathMetadata;
}

interface Ctx {
  sm: SettingsManager;
  cwd: string;
  agentDir: string;
  inherited: Map<string, { enabled: boolean; metadata: PathMetadata }>;
}

// `builtin:<name>` extensions are named by that path in every settings scope (pi's config selector).
const isBuiltin = (item: Item) => item.metadata.source === "builtin";
const packageManager = (cwd: string, agentDir: string, settingsManager: SettingsManager) =>
  new DefaultPackageManager({ cwd, agentDir, settingsManager, builtinExtensions: [...BUILTIN_EXTENSION_NAMES] });

const keyOf = (type: ResourceType, path: string) => `${type}:${realPathOrSelf(path)}`;
const target = (entry: string) => (/^[!+-]/.test(entry) ? entry.slice(1) : entry);
const sourceOf = (pkg: PackageSource) => (typeof pkg === "string" ? pkg : pkg.source);
const scopeOf = (item: Item): SettingsScope => (item.metadata.scope === "project" ? "project" : "user");
const isLocal = (source: string) => !/^(npm|git|github|http|https|ssh):/.test(source.trim());
const resolveFrom = (base: string, input: string) =>
  resolve(base, input.trim().replace(/^~(?=$|[/\\])/, homedir()));

function baseDirFor(ctx: Ctx, scope: SettingsScope): string {
  return scope === "project" ? join(ctx.cwd, CONFIG_DIR_NAME) : ctx.agentDir;
}

function isInherited(ctx: Ctx, item: Item): boolean {
  return scopeOf(item) === "user" || ctx.inherited.has(keyOf(item.type, item.path));
}

function sourcesMatch(ctx: Ctx, left: string, leftScope: SettingsScope, right: string, rightScope: SettingsScope): boolean {
  if (left === right) return true;
  if (!isLocal(left) || !isLocal(right)) return false;
  return resolveFrom(baseDirFor(ctx, leftScope), left) === resolveFrom(baseDirFor(ctx, rightScope), right);
}

function projectPackages(ctx: Ctx): PackageSource[] {
  return [...(ctx.sm.getProjectSettings().packages ?? [])];
}

function packagePattern(item: Item): string {
  return relative(item.metadata.baseDir ?? dirname(item.path), item.path);
}

function patternForProject(ctx: Ctx, item: Item): string {
  if (scopeOf(item) !== "project" || isBuiltin(item)) return item.path;
  return relative(item.metadata.baseDir ?? baseDirFor(ctx, "project"), item.path);
}

function topLevelPatterns(ctx: Ctx, item: Item): Set<string> {
  const patterns = new Set([patternForProject(ctx, item), item.path, relative(baseDirFor(ctx, "project"), item.path)]);
  if (item.metadata.baseDir) patterns.add(relative(item.metadata.baseDir, item.path));
  return patterns;
}

function stateFromEntries(entries: string[], patterns: Set<string>, emptyArrayIsUnload: boolean): OverrideState {
  if (entries.length === 0 && emptyArrayIsUnload) return "unload";
  let state: OverrideState = "inherit";
  for (const entry of entries) {
    if (!patterns.has(target(entry))) continue;
    state = entry.startsWith("!") || entry.startsWith("-") ? "unload" : "load";
  }
  return state;
}

function findProjectPackage(ctx: Ctx, item: Item): PackageSource | undefined {
  return projectPackages(ctx).find((entry) =>
    sourcesMatch(ctx, item.metadata.source, scopeOf(item), sourceOf(entry), "project"));
}

const isPerItem = (entry: string) => /^[+-]/.test(entry);
const isPlainPath = (entry: string) => !entry.startsWith("!") && !/[*?[{]/.test(entry);

/**
 * Whether per-item writes can express this resource's project state. A hand-written
 * package entry without `autoload: false` (a replacement that clones a project copy)
 * or a glob pattern such as `!**` would keep winning over a per-item entry, so a
 * switch there would silently do nothing.
 */
function isEditable(ctx: Ctx, item: Item): boolean {
  if (item.metadata.origin === "top-level") {
    return (ctx.sm.getProjectSettings()[item.type] ?? []).every((e) => isPerItem(e) || isPlainPath(e));
  }
  const pkg = findProjectPackage(ctx, item);
  if (pkg === undefined) return true;
  return typeof pkg === "object" && pkg.autoload === false
    && RESOURCE_TYPES.every((type) => (pkg[type] ?? []).every(isPerItem));
}

function getOverride(ctx: Ctx, item: Item): OverrideState {
  if (item.metadata.origin === "top-level") {
    return stateFromEntries(ctx.sm.getProjectSettings()[item.type] ?? [], topLevelPatterns(ctx, item), false);
  }
  const pkg = findProjectPackage(ctx, item);
  if (typeof pkg !== "object") return "inherit";
  const entries = pkg[item.type];
  if (entries === undefined) return "inherit";
  return stateFromEntries(entries, new Set([packagePattern(item)]), pkg.autoload !== false);
}

function setTopLevelOverride(ctx: Ctx, item: Item, state: OverrideState): void {
  const current = ctx.sm.getProjectSettings()[item.type] ?? [];
  const inherited = isInherited(ctx, item);
  const pattern = inherited ? item.path : patternForProject(ctx, item);
  const patterns = topLevelPatterns(ctx, item);
  const updated = current.filter((entry) => {
    if (/^[!+-]/.test(entry) && patterns.has(target(entry))) return false;
    return !(state === "inherit" && inherited && target(entry) === pattern);
  });
  if (state !== "inherit") {
    // Project entries name inherited files to override them; built-in paths need no entry.
    if (inherited && !isBuiltin(item) && !updated.includes(pattern)) updated.push(pattern);
    updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
  }
  if (item.type === "extensions") ctx.sm.setProjectExtensionPaths(updated);
  else if (item.type === "skills") ctx.sm.setProjectSkillPaths(updated);
  else if (item.type === "prompts") ctx.sm.setProjectPromptTemplatePaths(updated);
  else ctx.sm.setProjectThemePaths(updated);
}

function setPackageOverride(ctx: Ctx, item: Item, state: OverrideState): void {
  const packages = projectPackages(ctx);
  let index = packages.findIndex((entry) =>
    sourcesMatch(ctx, item.metadata.source, scopeOf(item), sourceOf(entry), "project"));
  if (index === -1) {
    if (state === "inherit") return;
    const source = item.metadata.source;
    packages.push({
      source: isLocal(source)
        ? relative(baseDirFor(ctx, "project"), resolveFrom(baseDirFor(ctx, scopeOf(item)), source)) || "."
        : source,
      autoload: false,
    });
    index = packages.length - 1;
  }
  // isEditable() guarantees an existing entry is an `autoload: false` object.
  const pkg = { ...(packages[index] as Exclude<PackageSource, string>) };
  packages[index] = pkg;
  const pattern = packagePattern(item);
  const updated = (pkg[item.type] ?? []).filter((entry) => target(entry) !== pattern);
  if (state !== "inherit") updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
  pkg[item.type] = updated.length > 0 ? updated : undefined;
  if (!RESOURCE_TYPES.some((type) => pkg[type] !== undefined)) packages.splice(index, 1);
  ctx.sm.setProjectPackages(packages);
}

function toItems(paths: ResolvedPaths): Item[] {
  return RESOURCE_TYPES.flatMap((type) => paths[type].map((resource) => ({ type, ...resource })));
}

async function loadScope(cwd: string, agentDir: string, onMissing: OnMissing) {
  const trust = getProjectTrustStatus(cwd, agentDir);
  // Same split as `pi config`: global view ignores project settings entirely.
  const globalSm = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const global = await packageManager(cwd, agentDir, globalSm).resolve(onMissing);
  const sm = SettingsManager.create(cwd, agentDir, { projectTrusted: trust.trusted });
  const project = trust.trusted
    ? await packageManager(cwd, agentDir, sm).resolve(onMissing)
    : global;
  const inherited = new Map(toItems(global).map((item) => [keyOf(item.type, item.path), item] as const));
  const ctx: Ctx = { sm, cwd, agentDir, inherited };
  return { ctx, trust, items: toItems(project) };
}

export async function resolveScopedResources(
  cwd: string,
  agentDir: string,
  onMissing: OnMissing = async () => "skip",
): Promise<{ resources: ScopedResource[]; trusted: boolean }> {
  const { ctx, trust, items } = await loadScope(cwd, agentDir, onMissing);
  const resources = items.map((item): ScopedResource => {
    const global = ctx.inherited.get(keyOf(item.type, item.path));
    return {
      type: item.type,
      path: item.path,
      enabled: item.enabled,
      metadata: item.metadata,
      owner: global?.metadata ?? item.metadata,
      globalEnabled: global ? global.enabled : null,
      override: trust.trusted ? getOverride(ctx, item) : "inherit",
      editable: !trust.trusted || isEditable(ctx, item),
    };
  });
  return { resources, trusted: trust.trusted };
}

/**
 * Toggle one globally configured resource in user settings, like `pi config`
 * (without `--local`): a `+/-` entry relative to the package root or the
 * top-level base dir. Unknown or non-global targets throw.
 */
export async function setGlobalResourceEnabled(
  cwd: string,
  agentDir: string,
  resource: { type: ResourceType; path: string },
  enabled: boolean,
): Promise<void> {
  const sm = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loadError = sm.drainErrors()[0];
  if (loadError) throw new Error(`Cannot read ${loadError.path ?? "global settings"}: ${loadError.error.message}`);
  const paths = await packageManager(cwd, agentDir, sm).resolve(async () => "skip");
  const key = keyOf(resource.type, resource.path);
  const item = toItems(paths).find((entry) => keyOf(entry.type, entry.path) === key && entry.metadata.scope === "user");
  if (!item) throw new Error(`Not a global resource: ${resource.path}`);
  const settings = sm.getGlobalSettings();
  const withEntry = (current: string[], pattern: string) => [
    ...current.filter((entry) => target(entry) !== pattern),
    `${enabled ? "+" : "-"}${pattern}`,
  ];
  if (item.metadata.origin === "top-level") {
    const pattern = isBuiltin(item) ? item.path : relative(item.metadata.baseDir ?? agentDir, item.path);
    const updated = withEntry(settings[item.type] ?? [], pattern);
    if (item.type === "extensions") sm.setExtensionPaths(updated);
    else if (item.type === "skills") sm.setSkillPaths(updated);
    else if (item.type === "prompts") sm.setPromptTemplatePaths(updated);
    else sm.setThemePaths(updated);
  } else {
    const packages = [...(settings.packages ?? [])];
    const index = packages.findIndex((entry) => sourceOf(entry) === item.metadata.source);
    if (index === -1) throw new Error(`Package not found in global settings: ${item.metadata.source}`);
    const entry = packages[index]!;
    const pkg = typeof entry === "string" ? { source: entry } : { ...entry };
    pkg[item.type] = withEntry(pkg[item.type] ?? [], packagePattern(item));
    packages[index] = pkg;
    sm.setPackages(packages);
  }
  await sm.flush();
  const writeError = sm.drainErrors()[0];
  if (writeError) throw new Error(`Cannot write ${writeError.path ?? "global settings"}: ${writeError.error.message}`);
}

export class ProjectNotTrustedError extends Error {}

/**
 * Make each target resource effectively `enabled` for `cwd`. A target that would
 * match its inherited (global) state drops its override; otherwise it gets an
 * explicit load/unload. Unknown targets are ignored.
 */
export async function setProjectOverrides(
  cwd: string,
  agentDir: string,
  targets: { type: ResourceType; path: string }[],
  enabled: boolean,
): Promise<void> {
  const { ctx, trust, items } = await loadScope(cwd, agentDir, async () => "skip");
  if (!trust.trusted) throw new ProjectNotTrustedError("Project resources must be trusted before changing project overrides");
  // A fresh folder gets trusted after the write below; refuse folders where that trust would spread.
  if (!trust.requiresTrust) await assertAutoTrustable(cwd, (message) => new ProjectNotTrustedError(message));
  // An unreadable settings file loads as {}; writing on top of that would replace the user's file.
  const loadError = ctx.sm.drainErrors()[0];
  if (loadError) throw new Error(`Cannot read ${loadError.path ?? `${loadError.scope} settings`}: ${loadError.error.message}`);
  const wanted = new Set(targets.map((t) => keyOf(t.type, t.path)));
  for (const item of items) {
    const key = keyOf(item.type, item.path);
    if (!wanted.has(key)) continue;
    if (!isEditable(ctx, item)) throw new Error(`Project settings entry for ${item.path} is hand-written; edit ${CONFIG_DIR_NAME}/settings.json directly`);
    // Same fallback as pi's getInheritedEnabled: project-only resources default to loaded.
    const inherited = ctx.inherited.get(key)?.enabled ?? (scopeOf(item) === "user" ? item.enabled : true);
    const state: OverrideState = enabled === inherited ? "inherit" : enabled ? "load" : "unload";
    if (item.metadata.origin === "top-level") setTopLevelOverride(ctx, item, state);
    else setPackageOverride(ctx, item, state);
  }
  await ctx.sm.flush();
  const writeError = ctx.sm.drainErrors()[0];
  if (writeError) throw new Error(`Cannot write ${writeError.path ?? "project settings"}: ${writeError.error.message}`);
  // The user just authored these project settings. If they are the only reason the
  // folder now needs trust, record that trust so the override actually applies.
  if (!trust.requiresTrust && hasTrustRequiringProjectResources(cwd)) trustProject(cwd, agentDir);
}
