const STORAGE_KEY = "pi-auto-session-title";

export function isAutoSessionTitleEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setAutoSessionTitleEnabled(enabled: boolean): void {
  window.localStorage.setItem(STORAGE_KEY, String(enabled));
}
