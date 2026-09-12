const STORAGE_KEY = "pi-shift-enter-to-send";

export function isShiftEnterToSend(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setShiftEnterToSend(enabled: boolean): void {
  window.localStorage.setItem(STORAGE_KEY, String(enabled));
}
