import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dump as stringifyYaml } from "js-yaml";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { parseFrontmatter } from "./frontmatter";
import { parseNpmSource } from "./plugin-updates";
import { subagentProfileSources } from "./subagent-profile-precedence";
import { ProjectNotTrustedError } from "./project-resource-overrides";
import { getProjectTrustStatus } from "./project-trust";
import { THINKING_LEVELS as VALID_THINKING_LEVELS } from "./thinking-levels";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isExistingPathWithinRoots } from "./path-security";
import { PRESET_READ_ONLY } from "./tool-presets";
import type { SessionEntry, SubagentSessionStatus } from "./types";

export const SUBAGENT_META_TYPE = "pi-web:subagent";
export const SUBAGENT_STATUS_TYPE = "pi-web:subagent-status";
export const SUBAGENT_RESULT_TYPE = "pi-web:subagent-result";
export const SUBAGENT_CONTROL_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"] as const;

export type SubagentStatus = SubagentSessionStatus;
export type SubagentScope = "builtin" | "global" | "workspace" | "project";
export type SubagentWritableScope = Exclude<SubagentScope, "builtin">;

export interface SubagentProfile {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  extensionTools?: string[];
  /** Resolve deny aliases against the same loaded sources as the grants. */
  disallowedExtensionTools?: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  promptMode?: "replace" | "append";
  isolation?: "worktree" | "off";
  enabled: boolean;
  /** File is only `enabled: false`: it hides the lower-precedence definition, as pi-subagents writes it. */
  disableStub?: boolean;
  scope: SubagentScope;
  filePath?: string;
  configurationError?: string;
}

export interface SubagentMetadata {
  version: 1;
  parentSessionId: string;
  parentSessionPath: string;
  parentToolCallId: string;
  profile: string;
  description: string;
  task: string;
  runInBackground: boolean;
  maxTurns?: number;
  isolation?: "worktree" | "off";
  createdAt: string;
  resourceSnapshot: SubagentResourceSnapshot;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface SubagentResourceSnapshot {
  version: 1;
  appendSystemPrompt: string[];
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  exactSystemPrompt?: string;
}

export interface SubagentSessionResources {
  appendSystemPrompt: string[];
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  exactSystemPrompt?: string;
}

export interface SubagentResultMetadata {
  version: 1;
  status: Exclude<SubagentStatus, "starting" | "running" | "queued" | "interrupted">;
  completedAt: string;
  wrappedAtTurnLimit?: boolean;
  result?: string;
  error?: string;
  worktreeCleanupError?: string;
  worktreeBranch?: string;
}

export interface SubagentRunInfo {
  sessionId: string;
  sessionPath: string;
  parentSessionId: string;
  parentToolCallId: string;
  profile: string;
  description: string;
  task: string;
  runInBackground: boolean;
  /** In-memory notification marker; not persisted or exposed in tool details. */
  resumed?: boolean;
  maxTurns?: number;
  isolation?: "worktree" | "off";
  status: SubagentStatus;
  createdAt: string;
  completedAt?: string;
  wrappedAtTurnLimit?: boolean;
  result?: string;
  error?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCleanupError?: string;
}

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const BUILTIN_TOOLS = new Set([...DEFAULT_TOOLS, "powershell"]);
const SUBAGENT_CONTROL_TOOLS = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
const THINKING_LEVELS = new Set<ThinkingLevel>(VALID_THINKING_LEVELS);

/** Keys the Agents editor rewrites. Everything else in a shared profile file is round-tripped. */
const MANAGED_FRONTMATTER_KEYS = new Set([
  "description",
  "display_name",
  "tools",
  "load_skills",
  "load_extensions",
  "enabled",
  "inherit_context",
  "run_in_background",
  "model",
  "thinking",
  "max_turns",
]);

const FRONTMATTER_OPEN_RE = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\n|\r)/;
const OWNED_ALIAS_VALUES = new Set(["none", "all", "true", "false"]);

const BUILTIN_PROFILES: SubagentProfile[] = [
  {
    name: "general-purpose",
    displayName: "General purpose",
    description: "Handle a focused implementation or investigation task",
    systemPrompt: "Work autonomously on the delegated task. Keep the final answer concise and include important files, decisions, and remaining risks.",
    tools: DEFAULT_TOOLS,
    loadSkills: false,
    loadExtensions: false,
    inheritContext: false,
    runInBackground: true,
    enabled: true,
    scope: "builtin",
  },
  {
    name: "explore",
    displayName: "Explore",
    description: "Quickly inspect a codebase without modifying it",
    systemPrompt: "Explore the codebase to answer the delegated question. Do not modify files. Report concrete findings with file paths and relevant symbols.",
    tools: [...PRESET_READ_ONLY],
    loadSkills: false,
    loadExtensions: false,
    inheritContext: false,
    runInBackground: true,
    enabled: true,
    scope: "builtin",
  },
  {
    name: "plan",
    displayName: "Plan",
    description: "Design an implementation plan without modifying files",
    systemPrompt: "Produce an implementation-ready plan for the delegated task. Inspect the repository as needed, do not modify files, and call out dependencies, risks, and verification steps.",
    tools: [...PRESET_READ_ONLY],
    loadSkills: false,
    loadExtensions: false,
    inheritContext: false,
    runInBackground: true,
    enabled: true,
    scope: "builtin",
  },
];

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return values.map((item) => String(item).trim()).filter(Boolean);
}

function parseTools(value: unknown, fallback: string[]): string[] {
  const tools = stringList(value);
  if (tools.includes("none")) return [];
  if (tools.includes("all") || tools.includes("*")) return [...DEFAULT_TOOLS];
  if (tools.length === 0) return [...fallback];
  return [...new Set(tools.filter((tool) => BUILTIN_TOOLS.has(tool)))];
}

function parseExtensionToolSelectors(value: unknown): string[] {
  return [...new Set(stringList(value).filter((tool) => tool.toLowerCase().startsWith("ext:")))];
}

function resourceFlag(
  data: Record<string, unknown> | null,
  managedKey: string,
  alias: string,
  fallback: boolean,
): boolean {
  const aliasValue = data?.[alias];
  let aliasFlag: boolean | undefined;
  if (typeof aliasValue === "boolean") aliasFlag = aliasValue;
  else if (typeof aliasValue === "string") {
    const normalized = aliasValue.trim().toLowerCase();
    if (normalized === "all" || normalized === "true") aliasFlag = true;
    else if (normalized === "none" || normalized === "false") aliasFlag = false;
    else throw new Error(`${alias} named lists are not supported by Pi Web; use a boolean ${alias} or ${managedKey}`);
  } else if (aliasValue !== undefined) {
    throw new Error(`${alias} named lists are not supported by Pi Web; use a boolean ${alias} or ${managedKey}`);
  }

  const managed = data?.[managedKey];
  if (managed !== undefined) {
    if (typeof managed === "boolean") return managed;
    throw new Error(`${managedKey} must be true or false`);
  }
  return aliasFlag ?? fallback;
}

function assertKnownProfileTools(value: unknown): void {
  if (
    value !== undefined
    && typeof value !== "string"
    && (!Array.isArray(value) || value.some((tool) => typeof tool !== "string"))
  ) {
    throw new Error("Subagent tools must be a string or an array of strings");
  }
  const unknown = stringList(value).filter((tool) => (
    tool !== "none"
    && tool !== "all"
    && tool !== "*"
    && !tool.toLowerCase().startsWith("ext:")
    && !BUILTIN_TOOLS.has(tool)
  ));
  if (unknown.length > 0) throw new Error(`Unknown subagent tools: ${unknown.join(", ")}`);
}

function validateSavedExtensionTools(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) {
    throw new Error("Subagent extensionTools must be an array of strings");
  }
  const tools = value.map((tool) => tool.trim());
  const invalid = tools.filter((tool) => !tool.toLowerCase().startsWith("ext:") || tool.length <= 4);
  if (invalid.length > 0) throw new Error(`Invalid subagent extension tools: ${invalid.join(", ")}`);
  return [...new Set(tools)];
}

function isProfileName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** Read existing frontmatter without allowing malformed metadata to be overwritten. */
function readStoredFrontmatter(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const source = readFileSync(filePath, "utf8");
  const { data } = parseFrontmatter(source);
  if (data) return data;
  if (FRONTMATTER_OPEN_RE.test(source)) {
    throw new Error("Cannot save agent profile: existing frontmatter is invalid");
  }
  return {};
}

function unmanagedFrontmatter(stored: Record<string, unknown>): Record<string, unknown> {
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!MANAGED_FRONTMATTER_KEYS.has(key)) preserved[key] = value;
  }
  return preserved;
}

function composeToolsField(
  tools: string[],
  storedTools: unknown,
  extensionTools: readonly string[] = [],
): string {
  const selectors = [
    ...extensionTools.filter((tool) => tool.toLowerCase().startsWith("ext:")),
    ...stringList(storedTools).filter((tool) => tool.toLowerCase().startsWith("ext:")),
  ];
  const uniqueSelectors = [...new Map(selectors.map((selector) => [selector.toLowerCase(), selector])).values()];
  const combined = [...tools, ...uniqueSelectors.filter((selector) => !tools.includes(selector))];
  return combined.length > 0 ? combined.join(", ") : "none";
}

function syncFlagAlias(
  frontmatter: Record<string, unknown>,
  alias: string,
  storedValue: unknown,
  flag: boolean,
): void {
  const owned = storedValue === undefined
    || typeof storedValue === "boolean"
    || (typeof storedValue === "string" && OWNED_ALIAS_VALUES.has(storedValue.trim().toLowerCase()));
  if (owned) frontmatter[alias] = flag;
}

function invalidProfile(
  filePath: string,
  scope: SubagentScope,
  name: string,
  error: unknown,
): SubagentProfile | null {
  if (!isProfileName(name)) return null;
  const message = error instanceof Error ? error.message : String(error);
  return {
    name,
    displayName: name,
    description: `Invalid profile: ${message}`,
    systemPrompt: "",
    tools: [],
    loadSkills: false,
    loadExtensions: false,
    inheritContext: false,
    runInBackground: true,
    enabled: false,
    scope,
    filePath,
    configurationError: message,
  };
}

function parseProfileFile(filePath: string, scope: SubagentScope): SubagentProfile | null {
  const fileName = basename(filePath, ".md");
  try {
    const source = readFileSync(filePath, "utf8");
    const { data, rest } = parseFrontmatter(source);
    if (FRONTMATTER_OPEN_RE.test(source) && !data) {
      return invalidProfile(filePath, scope, fileName, "Invalid frontmatter");
    }
    const named = stringValue(data?.name);
    if (named && !isProfileName(named)) {
      return invalidProfile(filePath, scope, fileName, `Invalid agent name: ${named}`);
    }
    const name = named && isProfileName(named) ? named : fileName;
    if (!isProfileName(name)) return invalidProfile(filePath, scope, fileName, `Invalid agent name: ${name}`);
    const thinkingValue = stringValue(data?.thinking) as ThinkingLevel | undefined;
    const maxTurnsValue = typeof data?.max_turns === "number" ? Math.floor(data.max_turns) : undefined;
    assertKnownProfileTools(data?.tools);
    const tools = parseTools(data?.tools, DEFAULT_TOOLS);
    const disallowedTools = new Set(parseTools(data?.disallowed_tools, []));
    const disallowedExtensionTools = parseExtensionToolSelectors(data?.disallowed_tools);
    // Keep the grants intact: removing the last one would activate the runtime's all-tools fallback.
    const extensionTools = parseExtensionToolSelectors(data?.tools);
    const loadSkills = resourceFlag(data, "load_skills", "skills", false);
    const loadExtensions = resourceFlag(
      data,
      "load_extensions",
      "extensions",
      extensionTools.length > 0,
    );
    return {
      name,
      displayName: stringValue(data?.display_name) ?? name,
      description: stringValue(data?.description) ?? name,
      systemPrompt: rest.trim(),
      tools: tools.filter((tool) => !disallowedTools.has(tool)),
      ...(extensionTools.length > 0 ? { extensionTools } : {}),
      ...(disallowedExtensionTools.length > 0 ? { disallowedExtensionTools } : {}),
      loadSkills,
      loadExtensions,
      ...(stringValue(data?.model) ? { model: stringValue(data?.model) } : {}),
      ...(thinkingValue && THINKING_LEVELS.has(thinkingValue) ? { thinking: thinkingValue } : {}),
      ...(maxTurnsValue && maxTurnsValue > 0 ? { maxTurns: maxTurnsValue } : {}),
      inheritContext: booleanValue(data?.inherit_context, false),
      runInBackground: booleanValue(data?.run_in_background, true),
      ...(data?.prompt_mode === "replace" || data?.prompt_mode === "append"
        ? { promptMode: data.prompt_mode }
        : {}),
      ...(data?.isolation === "worktree" || data?.isolation === "off"
        ? { isolation: data.isolation }
        : {}),
      enabled: booleanValue(data?.enabled, true),
      ...(isDisableStub(data, rest) ? { disableStub: true } : {}),
      scope,
      filePath,
    };
  } catch (error) {
    return invalidProfile(filePath, scope, fileName, error);
  }
}

const DISABLE_STUB = "---\nenabled: false\n---\n";

function isDisableStub(data: Record<string, unknown> | null, body: string): boolean {
  return data?.enabled === false && Object.keys(data).length === 1 && !body.trim();
}

function isProjectProfilePathAllowed(cwd: string, target: string): boolean {
  return isExistingPathWithinRoots(target, new Set([cwd]));
}

function readProfileDirectory(dir: string, scope: SubagentScope, cwd: string): SubagentProfile[] {
  if (!existsSync(dir)) return [];
  if (scope !== "global" && !isProjectProfilePathAllowed(cwd, dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => parseProfileFile(join(dir, entry.name), scope))
    .filter((profile): profile is SubagentProfile => profile !== null);
}

function profileDirectories(cwd: string): Array<[string, Exclude<SubagentScope, "builtin">]> {
  return [
    [join(getAgentDir(), "agents"), "global"],
    [join(resolve(cwd), ".agents", "agents"), "workspace"],
    [join(resolve(cwd), ".pi", "agents"), "project"],
  ];
}

/** Every configured source, including profiles shadowed by a higher-precedence scope. */
export function listSubagentProfileSources(cwd: string): SubagentProfile[] {
  const profiles = BUILTIN_PROFILES.map((profile) => ({ ...profile, tools: [...profile.tools] }));
  for (const [dir, scope] of profileDirectories(cwd)) {
    profiles.push(...readProfileDirectory(dir, scope, cwd));
  }
  return profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function listSubagentProfiles(cwd: string): SubagentProfile[] {
  const byName = new Map(BUILTIN_PROFILES.map((profile) => [profile.name.toLowerCase(), { ...profile, tools: [...profile.tools] }]));
  for (const [dir, scope] of profileDirectories(cwd)) {
    for (const profile of readProfileDirectory(dir, scope, cwd)) byName.set(profile.name.toLowerCase(), profile);
  }
  return [...byName.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function resolveSubagentProfile(cwd: string, name: string): SubagentProfile | undefined {
  const profile = listSubagentProfiles(cwd).find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
  if (profile?.configurationError) {
    throw new Error(`Invalid subagent profile "${profile.name}": ${profile.configurationError}`);
  }
  return profile?.enabled ? profile : undefined;
}

function assertProfileName(name: string): string {
  const normalized = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    throw new Error("Agent name may contain only letters, numbers, dots, underscores, and hyphens");
  }
  return normalized;
}

function writableProfileDirectory(cwd: string, scope: SubagentWritableScope): string {
  const dir = profileDirectories(cwd).find(([, candidate]) => candidate === scope)?.[0];
  if (!dir) throw new Error("Agent scope must be global, workspace, or project");
  return dir;
}

function assertWritableProfileDirectory(cwd: string, scope: SubagentWritableScope): string {
  const dir = writableProfileDirectory(cwd, scope);
  if (scope === "global") return dir;

  let existingAncestor = dir;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error("Agent profile directory is outside the project root");
    existingAncestor = parent;
  }
  if (!isProjectProfilePathAllowed(cwd, existingAncestor)) {
    throw new Error("Agent profile directory is outside the project root");
  }
  return dir;
}

/**
 * Writing `.pi/agents` or `.agents/agents` makes the next session load repository-authored
 * definitions, the same way writing project overrides does, so it rides the same trust gate.
 */
function assertProjectScopeTrusted(cwd: string): void {
  const status = getProjectTrustStatus(cwd, getAgentDir());
  if (status.requiresTrust && !status.trusted) {
    throw new ProjectNotTrustedError("Project resources must be trusted before changing project agents");
  }
}

/**
 * A project copy of an inherited agent starts from the definition it replaces, so frontmatter
 * this app does not model (prompt_mode, allowed_subagents, ext: selectors, ...) carries over.
 * An existing project definition is its own source; a disable stub has nothing worth keeping.
 */
function frontmatterSeedPath(cwd: string, scope: SubagentWritableScope, name: string, filePath: string): string {
  if (scope !== "project") return filePath;
  const sources = subagentProfileSources(listSubagentProfileSources(cwd), name);
  const own = sources.find((source) => source.scope === "project");
  if (own && !own.disableStub) return filePath;
  const inherited = sources.find((source) => source.scope !== "project" && source.filePath && !source.disableStub && !source.configurationError);
  return inherited?.filePath ?? filePath;
}

export function saveSubagentProfile(
  cwd: string,
  scope: SubagentWritableScope,
  profile: Omit<SubagentProfile, "scope" | "filePath">,
  /** Override the write path: a hand-written file's basename may differ from its frontmatter name. */
  targetPath?: string,
): SubagentProfile {
  if (scope !== "global") assertProjectScopeTrusted(cwd);
  const name = assertProfileName(profile.name);
  if (!Array.isArray(profile.tools)) throw new Error("Subagent tools must be an array of strings");
  assertKnownProfileTools(profile.tools);
  const tools = [...new Set(profile.tools)];
  if (profile.thinking && !THINKING_LEVELS.has(profile.thinking)) {
    throw new Error(`Invalid thinking level: ${profile.thinking}`);
  }
  if (profile.maxTurns !== undefined && (!Number.isFinite(profile.maxTurns) || profile.maxTurns < 0)) {
    throw new Error("Max turns must be a non-negative number");
  }
  const maxTurns = profile.maxTurns && profile.maxTurns > 0
    ? Math.floor(profile.maxTurns)
    : undefined;
  const displayName = profile.displayName.trim() || name;
  const description = profile.description.trim() || name;
  const systemPrompt = profile.systemPrompt.trim();
  const model = profile.model?.trim() || undefined;
  const loadSkills = profile.loadSkills === true;
  const loadExtensions = profile.loadExtensions === true;
  const extensionTools = validateSavedExtensionTools(profile.extensionTools);
  const dir = assertWritableProfileDirectory(cwd, scope);
  mkdirSync(dir, { recursive: true });
  if (scope !== "global" && !isProjectProfilePathAllowed(cwd, dir)) {
    throw new Error("Agent profile directory is outside the project root");
  }
  const filePath = targetPath ?? join(dir, `${name}.md`);
  const stored = readStoredFrontmatter(frontmatterSeedPath(cwd, scope, name, filePath));
  const managed: Record<string, unknown> = {
    description,
    display_name: displayName,
    tools: composeToolsField(tools, stored.tools, extensionTools),
    load_skills: loadSkills,
    load_extensions: loadExtensions,
    enabled: profile.enabled,
    inherit_context: profile.inheritContext,
    run_in_background: profile.runInBackground,
  };
  syncFlagAlias(managed, "skills", stored.skills, loadSkills);
  syncFlagAlias(managed, "extensions", stored.extensions, loadExtensions);
  if (model) managed.model = model;
  if (profile.thinking) managed.thinking = profile.thinking;
  if (maxTurns) managed.max_turns = maxTurns;
  if (profile.promptMode) managed.prompt_mode = profile.promptMode;
  if (profile.isolation) managed.isolation = profile.isolation;
  const frontmatter: Record<string, unknown> = { ...managed };
  for (const [key, value] of Object.entries(unmanagedFrontmatter(stored))) {
    if (!(key in frontmatter)) frontmatter[key] = value;
  }
  const yaml = stringifyYaml(frontmatter, { noRefs: true, lineWidth: 1000 }).trimEnd();
  writePrivateFileAtomicSync(filePath, `---\n${yaml}\n---\n\n${systemPrompt}\n`);
  const preservedSelectors = parseExtensionToolSelectors(frontmatter.tools);
  return {
    ...profile,
    name,
    displayName,
    description,
    systemPrompt,
    tools,
    ...(preservedSelectors.length > 0 ? { extensionTools: preservedSelectors } : { extensionTools: undefined }),
    loadSkills,
    loadExtensions,
    ...(model ? { model } : { model: undefined }),
    ...(maxTurns ? { maxTurns } : { maxTurns: undefined }),
    scope,
    filePath,
  };
}

export function deleteSubagentProfile(cwd: string, scope: SubagentWritableScope, name: string): void {
  if (scope !== "global") assertProjectScopeTrusted(cwd);
  const safeName = assertProfileName(name);
  const dir = assertWritableProfileDirectory(cwd, scope);
  // Locate the file by parse, not by `${name}.md`: a hand-written file's basename can differ from its name.
  const parsed = listSubagentProfileSources(cwd)
    .find((item) => item.scope === scope && item.name.toLowerCase() === safeName.toLowerCase())?.filePath;
  const filePath = parsed ?? join(dir, `${safeName}.md`);
  if (existsSync(filePath)) unlinkSync(filePath);
}

/**
 * Project-page switch: is this agent available in this project? Project state wins over the
 * global default, and flipping back to the inherited state drops the project file again —
 * a global agent is disabled here by a disable stub, a project definition is toggled in place.
 */
export function setSubagentProjectAvailability(cwd: string, name: string, enabled: boolean): void {
  assertProjectScopeTrusted(cwd);
  const top = subagentProfileSources(listSubagentProfileSources(cwd), name)[0];
  if (!top) throw new Error("Agent profile not found");
  if (top.configurationError) throw new Error(`Invalid subagent profile "${top.name}": ${top.configurationError}`);
  const dir = assertWritableProfileDirectory(cwd, "project");
  // The project scope has the highest precedence, so a project file, if any, is the top one.
  // It is located by parse, not by `${name}.md`: a hand-written file's basename can differ
  // from its frontmatter name, and a wrong path would fork the definition instead of toggling it.
  const project = top.scope === "project" ? top : null;
  if (project && !project.disableStub) {
    if (project.enabled !== enabled) saveSubagentProfile(cwd, "project", { ...project, enabled }, project.filePath);
    return;
  }
  if (enabled) {
    // The stub that hid the inherited definition comes off; with no stub there is nothing to enable.
    if (project) unlinkSync(project.filePath!);
    return;
  }
  // An inherited agent that still runs here is switched off by a stub; already off needs nothing.
  if (!project && top.enabled) {
    mkdirSync(dir, { recursive: true });
    writePrivateFileAtomicSync(join(dir, `${top.name}.md`), DISABLE_STUB);
  }
}

export type ImportScope = "global" | "project";

export interface ImportableAgentFile {
  file: string;
  name: string;
  displayName: string;
  description: string;
  /** Only `enabled: false`; importing it would hide the inherited definition. */
  disableStub: boolean;
  /** Present when the file cannot be imported at all. */
  error?: string;
  /** An agent of this name (or file) already exists in that target. */
  existsIn: Record<ImportScope, boolean>;
}

/** Agent definition files (`.pi/agents/*.md`) of another checkout; a folder that links out of it counts as empty. */
function sourceAgentFiles(sourceDir: string): string[] {
  const dir = join(sourceDir, ".pi", "agents");
  if (!existsSync(dir) || !isExistingPathWithinRoots(dir, new Set([sourceDir]))) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

export function countImportableAgentFiles(sourceDir: string): number {
  return sourceAgentFiles(sourceDir).length;
}

/** Logical agent names already defined in a directory, matched case-insensitively. */
function definedAgentNames(dir: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(dir)) return names;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const parsed = parseProfileFile(join(dir, entry.name), "global");
    if (parsed?.name) names.add(parsed.name.toLowerCase());
  }
  return names;
}

/** Same file name, or the same logical agent under a different name, counts as existing. */
function importTaken(dir: string, names: ReadonlySet<string>, file: string, name: string): boolean {
  return existsSync(join(dir, file)) || names.has(name.toLowerCase());
}

/** What the import dialog offers from another checkout's `.pi/agents`. */
export function listImportableAgentFiles(cwd: string, sourceDir: string): ImportableAgentFile[] {
  const agentsDir = join(sourceDir, ".pi", "agents");
  const targets = (["global", "project"] as const).map((scope) => {
    const dir = writableProfileDirectory(cwd, scope);
    return { scope, dir, names: definedAgentNames(dir) };
  });
  return sourceAgentFiles(sourceDir).map((file): ImportableAgentFile => {
    const stem = basename(file, ".md");
    const parsed = parseProfileFile(join(agentsDir, file), "global");
    const name = parsed?.name ?? stem;
    const error = parsed ? parsed.configurationError : "Invalid agent definition";
    return {
      file,
      name,
      displayName: parsed?.displayName ?? stem,
      description: parsed?.description ?? "",
      disableStub: parsed?.disableStub === true,
      ...(error ? { error } : {}),
      existsIn: Object.fromEntries(
        targets.map((target) => [target.scope, importTaken(target.dir, target.names, file, name)]),
      ) as Record<ImportScope, boolean>,
    };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Byte-copy picked agent definition files from another checkout into the target scope. Definitions may carry
 * frontmatter this app does not model, so import never round-trips through the profile form.
 */
export function importAgentProfiles(
  cwd: string,
  sourceDir: string,
  scope: ImportScope,
  files: readonly unknown[],
): { imported: string[]; skipped: { file: string; reason: string }[] } {
  if (scope !== "global") assertProjectScopeTrusted(cwd);
  const available = new Set(sourceAgentFiles(sourceDir));
  const dir = assertWritableProfileDirectory(cwd, scope);
  const names = definedAgentNames(dir);
  const imported: string[] = [];
  const skipped: { file: string; reason: string }[] = [];
  for (const file of files) {
    if (typeof file !== "string") continue;
    if (!file.endsWith(".md") || /[\\/]/.test(file) || !isProfileName(basename(file, ".md"))) {
      skipped.push({ file, reason: "Invalid file name" });
      continue;
    }
    // Same visibility rule as the preview: symlinks are not regular files, so a link pointing
    // outside the source can never be imported behind the dialog's back.
    if (!available.has(file)) {
      skipped.push({ file, reason: "Not a regular file" });
      continue;
    }
    const sourcePath = join(sourceDir, ".pi", "agents", file);
    try {
      const parsed = parseProfileFile(sourcePath, "global");
      if (!parsed || parsed.configurationError) {
        skipped.push({ file, reason: parsed?.configurationError ?? "Invalid agent definition" });
        continue;
      }
      if (importTaken(dir, names, file, parsed.name)) {
        skipped.push({ file, reason: "Already exists" });
        continue;
      }
      mkdirSync(dir, { recursive: true });
      // Copy verbatim with private permissions, like every other agent file write.
      writePrivateFileAtomicSync(join(dir, file), readFileSync(sourcePath));
      imported.push(file);
      names.add(parsed.name.toLowerCase());
    } catch (error) {
      // A file that vanished or became unreadable between preview and import skips alone.
      skipped.push({ file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { imported, skipped };
}

/**
 * Toggle the effective definition. The highest-precedence file wins whole, as in pi-subagents.
 * The Agents list is the user's global configuration, so an untouched built-in is disabled by a
 * global stub (its definition keeps following Pi Web updates); re-enabling removes the stub.
 * A project or workspace file is toggled in place and only affects that project.
 */
export function setSubagentProfileEnabled(cwd: string, name: string, enabled: boolean): void {
  const profile = listSubagentProfiles(cwd).find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
  if (!profile) throw new Error("Agent profile not found");
  if (profile.configurationError) throw new Error(`Invalid subagent profile "${profile.name}": ${profile.configurationError}`);
  if (profile.scope === "project" || profile.scope === "workspace") assertProjectScopeTrusted(cwd);
  if (profile.enabled === enabled) return;
  if (profile.scope === "builtin") {
    const dir = assertWritableProfileDirectory(cwd, "global");
    mkdirSync(dir, { recursive: true });
    writePrivateFileAtomicSync(join(dir, `${profile.name}.md`), DISABLE_STUB);
    return;
  }
  if (profile.disableStub) {
    unlinkSync(profile.filePath!);
    return;
  }
  saveSubagentProfile(cwd, profile.scope, { ...profile, enabled }, profile.filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ValidSubagentMetadataData = Record<string, unknown> & {
  version: 1;
  parentSessionId: string;
  parentSessionPath: string;
};

function subagentMetadataData(entries: readonly SessionEntry[]): ValidSubagentMetadataData | null {
  const metaEntry = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
  if (!metaEntry || metaEntry.type !== "custom" || !isRecord(metaEntry.data)) return null;
  const data = metaEntry.data;
  if (data.version !== 1 || typeof data.parentSessionId !== "string" || typeof data.parentSessionPath !== "string") return null;
  return data as ValidSubagentMetadataData;
}

export function readSubagentMetadata(entries: readonly SessionEntry[]): SubagentMetadata | null {
  const data = subagentMetadataData(entries);
  return data ? data as unknown as SubagentMetadata : null;
}

/** Restore the isolated prompt and tool scope used by a persisted subagent session. */
export function readSubagentSessionResources(
  entries: readonly SessionEntry[],
): SubagentSessionResources | null {
  const data = subagentMetadataData(entries);
  if (!data) return null;
  const snapshot = data.resourceSnapshot;
  const loadSkills = isRecord(snapshot) && snapshot.loadSkills === true;
  const loadExtensions = isRecord(snapshot) && snapshot.loadExtensions === true;
  if (
    isRecord(snapshot)
    && snapshot.version === 1
    && Array.isArray(snapshot.appendSystemPrompt)
    && snapshot.appendSystemPrompt.every((item) => typeof item === "string")
    && Array.isArray(snapshot.tools)
    && snapshot.tools.every((item) =>
      typeof item === "string"
      && item.length > 0
      && !SUBAGENT_CONTROL_TOOLS.has(item)
      && (BUILTIN_TOOLS.has(item) || loadExtensions)
    )
  ) {
    return {
      appendSystemPrompt: [...snapshot.appendSystemPrompt],
      tools: [...new Set(snapshot.tools)],
      loadSkills,
      loadExtensions,
      ...(typeof snapshot.exactSystemPrompt === "string"
        ? { exactSystemPrompt: snapshot.exactSystemPrompt }
        : {}),
    };
  }
  return null;
}

export function withSubagentExtensionTools(
  profileTools: readonly string[],
  extensionToolNames: Iterable<string>,
): string[] {
  return [...new Set([
    ...profileTools,
    ...[...extensionToolNames].filter((name) => !SUBAGENT_CONTROL_TOOLS.has(name)),
  ])];
}

interface SubagentExtensionLike {
  path: string;
  sourceInfo?: { source?: string; origin?: string };
  tools: Map<string, unknown>;
}

function extensionCandidates(extension: SubagentExtensionLike): { names: string[]; owner: string } {
  const segments = extension.path.replaceAll("\\", "/").split("/");
  const file = segments.at(-1) ?? "";
  const source = extension.sourceInfo?.source?.trim() ?? "";
  const npm = parseNpmSource(source);
  const packageSource = source !== "local" && source !== "auto"
    && (extension.sourceInfo?.origin === "package" || npm !== undefined);
  const packageName = packageSource ? npm?.name ?? source : "";
  return {
    names: [...new Set([
      segments.at(-2) ?? "", file, file.replace(/\.[^.]+$/, ""),
      packageName, packageName.replace(/^@[^/]+\//, ""),
    ].filter(Boolean).map((name) => name.toLowerCase()))],
    // Top-level resources share "local" / "auto", not an ownership identity.
    owner: packageSource ? source : extension.path,
  };
}

export function selectSubagentExtensionTools(
  extensions: Iterable<SubagentExtensionLike>,
  selectors: readonly string[],
  deniedSelectors: readonly string[] = [],
): string[] {
  const loaded = [...extensions].map((extension) => ({ extension, ...extensionCandidates(extension) }));
  const owners = new Map<string, Set<string>>();
  for (const { names, owner } of loaded) {
    for (const name of names) {
      const claimed = owners.get(name) ?? new Set<string>();
      claimed.add(owner);
      owners.set(name, claimed);
    }
  }
  const resolveAll = (values: readonly string[]) => values.flatMap((selector) => {
    if (!selector.toLowerCase().startsWith("ext:")) return [];
    const body = selector.slice(4).trim().replace(/\/+$/, "").replace(/\/\*$/, "");
    if (body === "*") return [{ name: "*", tool: undefined }];
    const lower = body.toLowerCase();
    // Resolve the longest name before the ambiguity check: never fall back to a shorter source.
    const name = [...owners.keys()]
      .filter((name) => lower === name || lower.startsWith(`${name}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (!name || owners.get(name)!.size !== 1) return [];
    return [{ name, tool: body.slice(name.length + 1) || undefined }];
  });
  const grants = resolveAll(selectors);
  const denials = resolveAll(deniedSelectors);
  return [...new Set(loaded.flatMap(({ extension, names }) => {
    const covers = (match: { name: string; tool?: string }, tool: string) => (
      (match.name === "*" || names.includes(match.name)) && (!match.tool || match.tool === tool)
    );
    return [...extension.tools.keys()].filter((tool) => (
      !SUBAGENT_CONTROL_TOOLS.has(tool)
      && grants.some((match) => covers(match, tool))
      && !denials.some((match) => covers(match, tool))
    ));
  }))];
}

const KNOWN_SUBAGENT_LIST_LIMIT = 20;

/**
 * Models mistype long session IDs. The error lists the subagents this parent has
 * already been told about so the next call can copy the right one; no fuzzy match,
 * which could silently steer or resume the wrong subagent.
 */
export function subagentNotFoundMessage(parentEntries: readonly SessionEntry[], sessionId: string): string {
  const known = new Map<string, string>();
  const remember = (id: string, label: string) => {
    known.delete(id);
    known.set(id, label);
  };
  for (const entry of parentEntries) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const details: unknown = (entry.message as { details?: unknown }).details;
      if (isRecord(details) && details.kind === "pi-web-subagent" && typeof details.sessionId === "string") {
        remember(details.sessionId, `${String(details.description)} (${String(details.profile)})`);
      }
    } else if (entry.type === "custom_message" && entry.customType === "pi-web:subagent-notification" && isRecord(entry.details)) {
      const ids = Array.isArray(entry.details.sessionIds) ? entry.details.sessionIds : [];
      for (const id of ids) {
        if (typeof id === "string") remember(id, known.get(id) ?? "background result notification");
      }
    }
  }
  if (known.size === 0) return `Subagent not found: ${sessionId}. No subagents have been started from this session.`;
  const lines = [...known].slice(-KNOWN_SUBAGENT_LIST_LIMIT).map(([id, label]) => `- ${id}: ${label}`);
  return `Subagent not found: ${sessionId}. Subagents known to this session (copy the ID exactly):\n${lines.join("\n")}`;
}

export function readSubagentRun(entries: readonly SessionEntry[], sessionId: string, sessionPath: string): SubagentRunInfo | null {
  const data = subagentMetadataData(entries);
  if (!data) return null;
  const lifecycleEntry = [...entries].reverse().find((entry) =>
    entry.type === "custom" && (entry.customType === SUBAGENT_RESULT_TYPE || entry.customType === SUBAGENT_STATUS_TYPE)
  );
  const resultEntry = lifecycleEntry?.type === "custom" && lifecycleEntry.customType === SUBAGENT_RESULT_TYPE
    ? lifecycleEntry
    : undefined;
  const result = resultEntry?.type === "custom" && isRecord(resultEntry.data) ? resultEntry.data : undefined;
  // queued/running are process state. Without the live run registry they are
  // leftovers from an interrupted process, not evidence of an active agent.
  const persistedStatus = result && (result.status === "completed" || result.status === "failed" || result.status === "aborted")
    ? result.status
    : "interrupted";
  return {
    sessionId,
    sessionPath,
    parentSessionId: data.parentSessionId,
    parentToolCallId: typeof data.parentToolCallId === "string" ? data.parentToolCallId : "",
    profile: typeof data.profile === "string" ? data.profile : "general-purpose",
    description: typeof data.description === "string" ? data.description : "Subagent",
    task: typeof data.task === "string" ? data.task : "",
    runInBackground: data.runInBackground === true,
    ...(typeof data.maxTurns === "number" && data.maxTurns > 0 ? { maxTurns: Math.floor(data.maxTurns) } : {}),
    ...(data.isolation === "worktree" || data.isolation === "off" ? { isolation: data.isolation } : {}),
    status: persistedStatus,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    ...(result && typeof result.completedAt === "string" ? { completedAt: result.completedAt } : {}),
    ...(result?.wrappedAtTurnLimit === true ? { wrappedAtTurnLimit: true } : {}),
    ...(result && typeof result.result === "string" ? { result: result.result } : {}),
    ...(result && typeof result.error === "string" ? { error: result.error } : {}),
    ...(typeof data.worktreePath === "string" ? { worktreePath: data.worktreePath } : {}),
    ...(typeof data.worktreeBranch === "string" ? { worktreeBranch: data.worktreeBranch } : {}),
    ...(result && typeof result.worktreeCleanupError === "string" ? { worktreeCleanupError: result.worktreeCleanupError } : {}),
    ...(result && typeof result.worktreeBranch === "string" ? { worktreeBranch: result.worktreeBranch } : {}),
  };
}
