/** Ask the app shell to show one routine on the Routines page (from a chat, e.g. a created-routine chip). */
export const OPEN_ROUTINE_EVENT = "pi-web:open-routine";

export function requestOpenRoutine(id: string): void {
  window.dispatchEvent(new CustomEvent<{ id: string }>(OPEN_ROUTINE_EVENT, { detail: { id } }));
}

/** Settings switched the Routines feature on or off; the shell shows or hides its entry. */
export const ROUTINES_FEATURE_EVENT = "pi-web:routines-feature";

export function announceRoutinesFeature(enabled: boolean): void {
  window.dispatchEvent(new CustomEvent<{ enabled: boolean }>(ROUTINES_FEATURE_EVENT, { detail: { enabled } }));
}
