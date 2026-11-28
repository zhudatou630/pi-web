"use client";

import { useSyncExternalStore } from "react";

// A scheme only swaps the --font-ui / --font-chat / --font-mono values in
// app/globals.css via html[data-font]. The pre-paint script in app/layout.tsx
// applies the same attribute from the same storage key.
// `system` is the default: anything not stored as another scheme (nothing yet,
// or the removed serif `claude`) reads as system.
export const FONT_SCHEMES = ["system", "sarasa", "wenkai"] as const;
export type FontScheme = (typeof FONT_SCHEMES)[number];

const STORAGE_KEY = "pi-font-scheme";
const listeners = new Set<() => void>();

function read(): FontScheme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return FONT_SCHEMES.includes(stored as FontScheme) ? (stored as FontScheme) : "system";
  } catch {
    return "system";
  }
}

function setFontScheme(scheme: FontScheme): void {
  const root = document.documentElement;
  // Sans is the bare stylesheet (Sarasa for prose); the others set html[data-font].
  if (scheme === "sarasa") delete root.dataset.font;
  else root.dataset.font = scheme;
  try {
    localStorage.setItem(STORAGE_KEY, scheme);
  } catch {
    // Best-effort browser preference persistence.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFontScheme() {
  const scheme = useSyncExternalStore(subscribe, read, () => "system" as FontScheme);
  return { scheme, setFontScheme };
}
