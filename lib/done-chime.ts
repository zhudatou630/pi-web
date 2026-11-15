// Every page of a browser hears the same completion: the page showing the session through
// its event stream, and every other page through its sidebar poll. A shared claim per
// session lets one of them chime. Best effort, not a lock: two pages deciding in the same
// instant can both chime, and storage that fails chimes as before.

const STORAGE_KEY = "pi-web:done-chimes";
const KEEP_MS = 10 * 60_000;
/** Pages showing one session receive its completion within about this window. */
export const SAME_COMPLETION_MS = 3_000;

type ChimeStorage = Pick<Storage, "getItem" | "setItem">;

function readClaims(storage: ChimeStorage): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

/**
 * Claims the chime for the completion of `sessionIds` and returns the ones nobody announced
 * since `since` (ms epoch): the page should chime once if any are returned.
 */
export function claimDoneChime(
  sessionIds: readonly string[],
  since: number,
  now = Date.now(),
  storage: ChimeStorage | null = typeof localStorage === "undefined" ? null : localStorage,
): string[] {
  if (!storage) return [...sessionIds];
  try {
    const claims = readClaims(storage);
    const unclaimed = sessionIds.filter((id) => !(typeof claims[id] === "number" && claims[id] >= since));
    if (unclaimed.length === 0) return [];
    const next: Record<string, number> = {};
    for (const [id, at] of Object.entries(claims)) if (typeof at === "number" && now - at < KEEP_MS) next[id] = at;
    for (const id of unclaimed) next[id] = now;
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
    return unclaimed;
  } catch {
    return [...sessionIds];
  }
}
