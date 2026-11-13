/** Ask the app shell to show one routine on the Routines page (from a chat, e.g. a created-routine chip). */
export const OPEN_ROUTINE_EVENT = "pi-web:open-routine";

export function requestOpenRoutine(id: string): void {
  window.dispatchEvent(new CustomEvent<{ id: string }>(OPEN_ROUTINE_EVENT, { detail: { id } }));
}
