/** Server-observed family completion boundaries, shared by all running-route requests. */
// shortcut: completion history is process-local; add durable delivery only if missed/offline runs must be recovered.
const key = Symbol.for("pi-web:completion-snapshot");
interface CompletionState { pending: Set<string>; completedAt: Record<string, number> }
const globalState = globalThis as typeof globalThis & { [key]?: CompletionState };

export function noteSessionCompletions(pendingIds: readonly string[], now: number): Record<string, number> {
  const state = globalState[key] ??= { pending: new Set(), completedAt: {} };
  const pending = new Set(pendingIds);
  for (const id of state.pending) if (!pending.has(id)) state.completedAt[id] = now;
  for (const id of pending) delete state.completedAt[id];
  state.pending = pending;
  return { ...state.completedAt };
}
