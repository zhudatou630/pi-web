const STORAGE_KEY = "pi-sidebar-single-project";

// Broadcast so the mounted sidebar switches layout when the setting changes.
export const SIDEBAR_SINGLE_PROJECT_EVENT = "pi-sidebar-single-project-changed";

export function isSidebarSingleProject(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "true";
}

export function setSidebarSingleProject(enabled: boolean): void {
  window.localStorage.setItem(STORAGE_KEY, String(enabled));
  window.dispatchEvent(new Event(SIDEBAR_SINGLE_PROJECT_EVENT));
}
