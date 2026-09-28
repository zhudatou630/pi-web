import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { ProjectFeatureState } from "./api-types";
import { projectFeatureState, withProjectOverride } from "./project-feature-switch";

export interface SubagentSettings {
  builtInEnabled: boolean;
  maxConcurrent: number;
}

type StoredSubagentSettings = Record<string, unknown> & {
  version?: unknown;
  builtInEnabled?: unknown;
  maxConcurrent?: unknown;
  projects?: unknown;
  disabledProjects?: unknown;
};

export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 10;
export const MAX_SUBAGENT_MAX_CONCURRENT = 32;

function readMaxConcurrent(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_SUBAGENT_MAX_CONCURRENT
    ? value
    : DEFAULT_SUBAGENT_MAX_CONCURRENT;
}

export function getSubagentSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "agents", "settings.json");
}

function readStoredSettings(settingsPath: string): StoredSubagentSettings {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid subagent settings: expected an object");
  }
  return parsed as StoredSubagentSettings;
}

export function readSubagentSettings(
  settingsPath = getSubagentSettingsPath(),
): SubagentSettings {
  const stored = readStoredSettings(settingsPath);
  return {
    // Default on: the foreman workflow is the product, not an experiment.
    builtInEnabled: stored.builtInEnabled !== false,
    maxConcurrent: readMaxConcurrent(stored.maxConcurrent),
  };
}

/** This project's sub-agent state: its own setting when it has one, else the global default. */
export function subagentProjectState(
  projectRoot: string,
  settingsPath = getSubagentSettingsPath(),
): ProjectFeatureState {
  const stored = readStoredSettings(settingsPath);
  return projectFeatureState(stored, projectRoot, stored.builtInEnabled !== false);
}

/** Effective switch for one project (project override wins). Unreadable settings fail closed. */
export function isSubagentsEnabledForProject(
  projectRoot: string,
  settingsPath = getSubagentSettingsPath(),
): boolean {
  try {
    return subagentProjectState(projectRoot, settingsPath).enabled;
  } catch {
    return false;
  }
}

export function writeProjectSubagentsEnabled(
  projectRoot: string,
  enabled: boolean,
  settingsPath = getSubagentSettingsPath(),
): void {
  const stored = readStoredSettings(settingsPath);
  const next = withProjectOverride({ ...stored, version: 1 }, projectRoot, enabled, stored.builtInEnabled !== false);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify(next, null, 2));
}

export function writeBuiltInSubagentsEnabled(
  enabled: boolean,
  settingsPath = getSubagentSettingsPath(),
): SubagentSettings {
  const stored = readStoredSettings(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({
    ...stored,
    version: 1,
    builtInEnabled: enabled,
  }, null, 2));
  return readSubagentSettings(settingsPath);
}

export function writeSubagentMaxConcurrent(
  maxConcurrent: number,
  settingsPath = getSubagentSettingsPath(),
): SubagentSettings {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MAX_SUBAGENT_MAX_CONCURRENT) {
    throw new Error(`maxConcurrent must be an integer between 1 and ${MAX_SUBAGENT_MAX_CONCURRENT}`);
  }
  const stored = readStoredSettings(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({
    ...stored,
    version: 1,
    maxConcurrent,
  }, null, 2));
  return readSubagentSettings(settingsPath);
}
