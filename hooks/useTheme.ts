"use client";

import { useCallback, useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";
// Palette and light/dark mode are independent: data-theme picks the palette,
// .dark the mode, so every palette gets light, dark, and system.
export type ThemePalette = "default" | "claude";

type ThemeState = {
  preference: ThemePreference;
  theme: ResolvedTheme;
  palette: ThemePalette;
};

type ToggleOrigin = { x: number; y: number };

const STORAGE_KEY = "pi-theme";
const PALETTE_STORAGE_KEY = "pi-theme-palette";
const PREFERENCE_CYCLE: ThemePreference[] = ["light", "dark", "auto"];
const SERVER_SNAPSHOT: ThemeState = { preference: "auto", theme: "light", palette: "default" };

const listeners = new Set<() => void>();
let state: ThemeState | null = null;
let systemListening = false;

function emit(): void {
  listeners.forEach((cb) => cb());
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode, quota, etc.
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
}

function readStoredPreference(): ThemePreference {
  const value = readStored(STORAGE_KEY);
  return value === "light" || value === "dark" ? value : "auto";
}

function readStoredPalette(): ThemePalette {
  return readStored(PALETTE_STORAGE_KEY) === "claude" ? "claude" : "default";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "auto" ? getSystemTheme() : preference;
}

// Match --bg-panel so the PWA status bar blends into the workspace header.
const THEME_COLOR: Record<ThemePalette, Record<ResolvedTheme, string>> = {
  default: { light: "#f5f5f5", dark: "#242424" },
  claude: { light: "#fafaf4", dark: "#111111" },
};

function applyThemeColor(palette: ThemePalette, theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const color = THEME_COLOR[palette][theme];
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (metas.length === 0) {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = color;
    document.head.appendChild(meta);
    return;
  }
  for (const meta of metas) {
    meta.removeAttribute("media");
    meta.content = color;
  }
}

function applyDomTheme(palette: ThemePalette, theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  if (palette === "default") delete root.dataset.theme;
  else root.dataset.theme = palette;
  applyThemeColor(palette, theme);
}

function ensureState(): ThemeState {
  if (typeof window === "undefined") return SERVER_SNAPSHOT;
  if (state) return state;

  const preference = readStoredPreference();
  const palette = readStoredPalette();
  const theme = resolveTheme(preference);
  applyDomTheme(palette, theme);
  state = { preference, theme, palette };
  return state;
}

function setThemeState(next: ThemeState, persist: boolean): void {
  applyDomTheme(next.palette, next.theme);
  if (persist) {
    writeStored(STORAGE_KEY, next.preference);
    writeStored(PALETTE_STORAGE_KEY, next.palette);
  }
  state = next;
  emit();
}

function syncAutoThemeFromSystem(): void {
  const current = ensureState();
  if (current.preference !== "auto") return;
  const theme = getSystemTheme();
  if (theme === current.theme) return;
  setThemeState({ ...current, theme }, false);
}

function ensureSystemListener(): void {
  if (systemListening || typeof window === "undefined" || !window.matchMedia) return;

  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", syncAutoThemeFromSystem);
  // Some browsers delay or miss scheme events while backgrounded.
  window.addEventListener("focus", syncAutoThemeFromSystem);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncAutoThemeFromSystem();
  });
  systemListening = true;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  ensureState();
  ensureSystemListener();
  syncAutoThemeFromSystem();
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ThemeState {
  return ensureState();
}

function getServerSnapshot(): ThemeState {
  return SERVER_SNAPSHOT;
}

function nextPreference(preference: ThemePreference): ThemePreference {
  const index = PREFERENCE_CYCLE.indexOf(preference);
  return PREFERENCE_CYCLE[(index + 1) % PREFERENCE_CYCLE.length];
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setThemePreference = useCallback((nextPreference: ThemePreference, origin?: ToggleOrigin) => {
    const current = ensureState();
    if (current.preference === nextPreference) return;
    const nextTheme = resolveTheme(nextPreference);

    const apply = () => {
      setThemeState({ ...ensureState(), preference: nextPreference, theme: nextTheme }, true);
    };

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const supportsVT = typeof document.startViewTransition === "function";

    if (!supportsVT || reduceMotion) {
      apply();
      return;
    }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    const transition = document.startViewTransition(apply);
    transition.ready
      .then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${endRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 450,
            easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {
        // transition cancelled — ignore
      });
  }, []);

  const setThemePalette = useCallback((palette: ThemePalette) => {
    const current = ensureState();
    if (current.palette !== palette) setThemeState({ ...current, palette }, true);
  }, []);

  const toggleTheme = useCallback((origin?: ToggleOrigin) => {
    const current = ensureState();
    setThemePreference(nextPreference(current.preference), origin);
  }, [setThemePreference]);

  return {
    theme: snapshot.theme,
    preference: snapshot.preference,
    palette: snapshot.palette,
    setThemePreference,
    setThemePalette,
    toggleTheme,
    isDark: snapshot.theme === "dark",
  };
}
