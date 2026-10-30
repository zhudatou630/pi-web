import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { applyProjectOrderUpdate, isProjectKey, isProjectNames, isProjectOrderUpdate, projectDisplayName, projectNamesFit, projectOrderFits, type ProjectOrderUpdate } from "./project-groups";

export interface SidebarState {
  version: 1;
  pinned: string[];
  archived: Record<string, string>;
  projectOrder?: string[];
  /** Project display names keyed by project key; an absent key means no name. */
  projectNames?: Record<string, string>;
  [key: string]: unknown;
}

type SidebarUpdate = { pinned: boolean; archived?: never } | { archived: boolean; pinned?: never };
export const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const emptyState = (): SidebarState => ({ version: 1, pinned: [], archived: {} });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function getSidebarStatePath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", "sidebar-state.json");
}

function readJson(path: string): unknown {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`Corrupt sidebar state: ${path}; refusing to overwrite`); }
}

function loadState(path: string): SidebarState {
  const value = readJson(path);
  if (value === undefined) {
    const legacy = readJson(join(dirname(path), "pinned-sessions.json"));
    if (legacy === undefined) return emptyState();
    if (Array.isArray(legacy) && legacy.every((id) => typeof id === "string" && SESSION_ID_PATTERN.test(id))) {
      return { ...emptyState(), pinned: [...new Set(legacy)] };
    }
  } else if (isRecord(value) && value.version === 1
    && Array.isArray(value.pinned) && value.pinned.every((id) => typeof id === "string" && SESSION_ID_PATTERN.test(id))
    && (value.projectOrder === undefined || (Array.isArray(value.projectOrder)
      && value.projectOrder.every(isProjectKey) && new Set(value.projectOrder).size === value.projectOrder.length
      && projectOrderFits(value.projectOrder)))
    && (value.projectNames === undefined || isProjectNames(value.projectNames))
    && isRecord(value.archived) && Object.entries(value.archived).every(([id, time]) =>
      SESSION_ID_PATTERN.test(id) && typeof time === "string" && Number.isFinite(Date.parse(time)))) {
    return value as SidebarState;
  }
  throw new Error(`Corrupt sidebar state: ${path}; refusing to overwrite`);
}

/** Corruption reads as empty, but the locked write below refuses to replace it. */
export function readSidebarState(path = getSidebarStatePath()): SidebarState {
  try { return loadState(path); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("Corrupt sidebar state:")) return emptyState();
    throw error;
  }
}

/** Lock even a missing file; all sidebar read-modify-writes share this lock. */
async function mutateSidebarState(
  mutate: (state: SidebarState) => boolean, path: string,
): Promise<{ state: SidebarState; changed: boolean }> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let compromised: Error | undefined;
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
    onCompromised: (error) => { compromised = error; },
  });
  try {
    const state = loadState(path);
    const changed = mutate(state);
    if (compromised) throw compromised;
    if (changed) writePrivateFileAtomicSync(path, JSON.stringify(state, null, 2) + "\n", 0o600, { followSymlinks: true });
    return { state, changed };
  } finally {
    await release();
  }
}

export async function updateProjectOrder(update: ProjectOrderUpdate, path = getSidebarStatePath()) {
  if (!isProjectOrderUpdate(update)) throw new Error("Invalid project order update");
  return mutateSidebarState((state) => {
    const next = applyProjectOrderUpdate(state.projectOrder ?? [], update);
    if (JSON.stringify(next) === JSON.stringify(state.projectOrder ?? [])) return false;
    state.projectOrder = next;
    return true;
  }, path);
}

/** Sets a project's display name, or clears it when name is "". False (nothing written) when the store has no room. */
export async function updateProjectName(projectKey: string, name: string, path = getSidebarStatePath()): Promise<boolean> {
  if (!isProjectKey(projectKey) || projectDisplayName(name) !== name) throw new Error("Invalid project name update");
  let stored = true;
  await mutateSidebarState((state) => {
    const names = { ...state.projectNames };
    if (name) names[projectKey] = name;
    else delete names[projectKey];
    if (!projectNamesFit(names)) {
      stored = false;
      return false;
    }
    if (JSON.stringify(names) === JSON.stringify(state.projectNames ?? {})) return false;
    state.projectNames = names;
    return true;
  }, path);
  return stored;
}

export async function removeSidebarSessions(ids: readonly string[], path = getSidebarStatePath()): Promise<void> {
  const removed = new Set(ids);
  await mutateSidebarState((state) => {
    const pinned = state.pinned.filter((id) => !removed.has(id));
    const archived = Object.fromEntries(Object.entries(state.archived).filter(([id]) => !removed.has(id)));
    if (pinned.length === state.pinned.length && Object.keys(archived).length === Object.keys(state.archived).length) return false;
    state.pinned = pinned;
    state.archived = archived;
    return true;
  }, path);
}

export async function updateSidebarState(
  ids: readonly string[], update: SidebarUpdate, path = getSidebarStatePath(),
): Promise<SidebarState> {
  if (!ids.length || ids.some((id) => !SESSION_ID_PATTERN.test(id))) throw new Error("Invalid session ids");
  if ((typeof update.pinned === "boolean") === (typeof update.archived === "boolean")) {
    throw new Error("Send exactly one of pinned or archived");
  }
  return (await mutateSidebarState((state) => {
    const archivedAt = new Date().toISOString();
    for (const id of new Set(ids)) {
      if (typeof update.pinned === "boolean") {
        state.pinned = state.pinned.filter((item) => item !== id);
        if (update.pinned) {
          state.pinned.push(id);
          delete state.archived[id];
        }
      } else if (update.archived) {
        state.pinned = state.pinned.filter((item) => item !== id);
        state.archived[id] = archivedAt;
      } else {
        delete state.archived[id];
      }
    }
    return true;
  }, path)).state;
}
