export const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
export type UnreadMarks = Map<string, number>;

/** Older versions stored an id array; any shared read can clear those undated marks. */
export function parseUnreadMarks(raw: string | null): UnreadMarks {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (Array.isArray(value)) return new Map(value.filter((id): id is string => typeof id === "string").map((id) => [id, 0]));
    return new Map(value && typeof value === "object" ? Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0) : []);
  } catch { return new Map(); }
}

export function withoutReadMarks(marks: UnreadMarks, readAt: Readonly<Record<string, number>>): UnreadMarks {
  const next = new Map([...marks].filter(([id, at]) => !Object.hasOwn(readAt, id) || at > readAt[id]));
  return next.size === marks.size ? marks : next;
}

export function sameUnreadMarks(a: UnreadMarks, b: UnreadMarks): boolean {
  return a.size === b.size && [...a].every(([id, at]) => b.get(id) === at);
}

export function hasRecentAttention(lastInput: number | null, now: number, visible: boolean, focused: boolean): boolean {
  return visible && focused && lastInput !== null && now - lastInput < 120_000;
}
