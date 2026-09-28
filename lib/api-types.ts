import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile } from "./subagents";

/** A Pi Web feature's state in one project; the project's own setting wins over the global default. */
export interface ProjectFeatureState {
  root: string;
  /** Effective here. */
  enabled: boolean;
  /** This project has its own setting that differs from the global default. */
  overridden: boolean;
}

export interface SubagentProfilesResponse {
  profiles: SubagentProfile[];
}

export interface SubagentSettingsResponse {
  enabled: boolean;
  maxConcurrent: number;
  /** Present when the request named a cwd: that project's state (its override wins over `enabled`). */
  project?: ProjectFeatureState;
}

export interface ImageGenerationSettingsConnection {
  id: string;
  label: string;
  provider: string;
  model: string;
  enabled: boolean;
  signedIn: boolean;
  kind: "builtin" | "custom";
}

export interface ImageGenerationSettingsProvider {
  id: string;
  name: string;
  signedIn: boolean;
}

export interface ImageGenerationSettingsResponse {
  enabled: boolean;
  defaultConnection: string;
  connections: ImageGenerationSettingsConnection[];
  providers: ImageGenerationSettingsProvider[];
  /** Present when the request named a cwd: that project's state (its override wins over `enabled`). */
  project?: ProjectFeatureState;
}

export interface ShellToolSettingsResponse {
  isWindows: boolean;
  powerShellEnabled: boolean;
}

export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

export type SkillInstallScope = "global" | "project";

export interface SkillInstallInfo {
  package: string;
  scope: SkillInstallScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  canCheckForUpdates: boolean;
}

export type SkillUpdateState =
  | "up-to-date"
  | "update-available"
  | "unsupported"
  | "error";

export interface SkillUpdateResult {
  package: string;
  scope: SkillInstallScope;
  state: SkillUpdateState;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  /** Loaded for this cwd (global state plus any project override). */
  enabled: boolean;
  /** Global switch; null when the skill has none (project files, project packages, extension-provided). */
  globalEnabled: boolean | null;
  sourceInfo: {
    source?: string;
    scope?: string;
    /** "package" when a plugin package ships the skill; its files are not ours to edit. */
    origin?: string;
  };
  install?: SkillInstallInfo;
  /** Lives directly in an auto-discovered skills directory, so the Skills panel may delete it. */
  removable?: boolean;
  projectOverride?: ProjectOverride;
}

export interface SkillsResponse {
  skills: SkillInfo[];
  diagnostics: ResourceDiagnostic[];
  projectResourcesLoaded: boolean;
}

export interface ProjectTrustStatus {
  requiresTrust: boolean;
  trusted: boolean;
}

export interface AppUpdateResponse {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  canUpdate?: boolean;
  manualCommand?: string;
}

export interface PushConfigResponse {
  publicKey: string;
}

export type PluginScope = "global" | "project";
/** Per-project override of a global resource, same states as `pi config --local`. */
export type ProjectOverride = "inherit" | "load" | "unload";
export type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";

export interface PluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface PluginDiagnostic {
  type: "warning" | "error";
  message: string;
  source?: string;
  path?: string;
}

export interface PluginResourceInfo {
  kind: PluginResourceKind;
  name: string;
  path: string;
  relativePath: string;
  /** Effective for this cwd. */
  enabled: boolean;
  /** State in global settings; null when the resource is project-only. */
  globalEnabled: boolean | null;
  projectOverride: ProjectOverride;
}

export interface PluginStandaloneExtensionInfo extends PluginResourceInfo {
  kind: "extension";
  scope: PluginScope;
}

export type PluginUpdateState =
  | "update-available"
  | "up-to-date"
  | "unsupported"
  | "error";

export interface PluginUpdateResult {
  source: string;
  scope: PluginScope;
  displayName: string;
  type: "npm" | "git";
  state: PluginUpdateState;
  message?: string;
}

export interface PluginPackageInfo {
  source: string;
  scope: PluginScope;
  canCheckForUpdates: boolean;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  counts: PluginResourceCounts;
  /** All resources, including ones not loaded for this cwd. */
  resources: PluginResourceInfo[];
  projectOverride: ProjectOverride | "mixed";
  status: "loaded" | "installed" | "missing" | "disabled";
}

export interface PluginsResponse {
  packages: PluginPackageInfo[];
  standaloneExtensions: PluginStandaloneExtensionInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
  projectResourcesLoaded: boolean;
}

export type ProjectResourceType = "extensions" | "skills" | "prompts" | "themes";

export interface ProjectResourceItem {
  type: ProjectResourceType;
  path: string;
  name: string;
  /** Effective for this project. */
  enabled: boolean;
  /** null: exists only in this project. */
  globalEnabled: boolean | null;
  /** This project overrides the inherited state. */
  overridden: boolean;
  /** false: a hand-written project entry pi-web cannot change. */
  editable: boolean;
}

export interface ProjectResourceGroup {
  key: string;
  origin: "package" | "top-level";
  scope: PluginScope;
  source: string;
  label: string;
  items: ProjectResourceItem[];
}

export type ProjectOverrideSyncKind = "none" | "subdirectory" | "tracked" | "worktrees";

export interface ProjectResourcesResponse {
  projectResourcesLoaded: boolean;
  groups: ProjectResourceGroup[];
  /** Where a change is written; `otherWorktrees` counts checkouts besides cwd. */
  sync: { kind: ProjectOverrideSyncKind; otherWorktrees: number };
}

export interface ProjectOverridesWriteResponse {
  ok: true;
  /** Other worktrees that could not take the change (untrusted, hand-written entry, …). */
  failures: { path: string; error: string }[];
}
