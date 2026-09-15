const PINNED_CWDS_STORAGE_KEY = "pi-web:pinned-cwds";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const path = item.trim();
    if (!path || paths.includes(path)) continue;
    paths.push(path);
  }
  return paths;
}

export function loadPinnedCwds(storage: StorageLike | null = getBrowserStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PINNED_CWDS_STORAGE_KEY);
    if (!raw) return [];
    return readPaths(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function savePinnedCwds(
  paths: readonly string[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PINNED_CWDS_STORAGE_KEY, JSON.stringify(readPaths(paths)));
  } catch {
    // Persistence is best-effort; privacy mode and storage quotas must not break the sidebar.
  }
}

export function togglePinnedCwd(paths: readonly string[], cwd: string): string[] {
  const path = cwd.trim();
  if (!path) return readPaths(paths);
  return paths.includes(path) ? paths.filter((item) => item !== path) : [...paths, path];
}
