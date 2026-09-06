"use client";

import { useEffect } from "react";

// ---------------------------------------------------------------------------
// Module-level registry — ChatWindow registers the abort handler here so that
// the global Esc listener in AppShell can call it without prop-drilling.
// ---------------------------------------------------------------------------
let globalAbortHandler: (() => void) | null = null;

/**
 * Register (or clear) the abort handler for the global Esc shortcut.
 * Call this from ChatWindow whenever agentRunning or handleAbort changes.
 */
export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}

export function isComposerKeyboardTarget(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === "TEXTAREA" || tag === "INPUT";
}

export function handleGlobalShortcutKeyDown(
  event: KeyboardEvent,
  options: {
    abortHandler?: (() => void) | null;
    onNewSession?: (cwd: string) => void;
    activeCwd?: string | null;
  } = {},
): void {
  if (event.defaultPrevented) return;

  if (event.key === "Escape") {
    const abortHandler = options.abortHandler === undefined ? globalAbortHandler : options.abortHandler;
    if (!abortHandler || isComposerKeyboardTarget(event.target)) return;
    event.preventDefault();
    abortHandler();
    return;
  }

  if (event.key === "n" && event.ctrlKey && event.altKey) {
    if (!options.activeCwd || !options.onNewSession) return;
    event.preventDefault();
    options.onNewSession(options.activeCwd);
  }
}

// ---------------------------------------------------------------------------
// Hook: global keyboard shortcuts
// ---------------------------------------------------------------------------

interface UseGlobalKeyboardShortcutsOptions {
  /** Called when Ctrl+Alt+N is pressed. Receives current cwd. */
  onNewSession?: (cwd: string) => void;
  /** The currently selected project directory (sidebar cwd). */
  activeCwd?: string | null;
}

/**
 * Register global keyboard shortcuts for the application.
 *
 * Shortcuts handled here:
 *   Esc          – stop the running agent (via module-level abort handler)
 *   Ctrl+Alt+N   – create a new session in the active project directory
 *
 * Note: Esc inside <textarea> or <input> is deliberately NOT handled here.
 * ChatInput manages its own Esc logic (closing slash / @ file menus, stopping
 * the agent when no menu is open) because it needs intimate knowledge of menu
 * state that is local to that component.
 */
export function useGlobalKeyboardShortcuts(
  options: UseGlobalKeyboardShortcutsOptions,
): void {
  const { onNewSession, activeCwd } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      handleGlobalShortcutKeyDown(e, { onNewSession, activeCwd });
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeCwd, onNewSession]);
}
