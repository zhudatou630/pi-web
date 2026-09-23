import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { PRESET_FULL } from "./tool-presets";
import type { SessionEntry } from "./types";

export const TOOL_SELECTION_TYPE = "pi-web:tool-selection";

export interface SessionToolSelectionData {
  version: 1;
  tools: string[];
}

/**
 * Written when the user returns a session to Pi's configured `defaultTools`.
 * The session log is append-only, so an earlier pin can only be retracted by a
 * later entry that says so; without it the newest pin would win forever.
 */
export interface ClearedSessionToolSelectionData {
  version: 1;
  cleared: true;
}

const BUILTIN_TOOL_NAMES = new Set(PRESET_FULL);
/** Distinguishes "the log says follow settings.json" from "no entry at all". */
const CLEARED = Symbol("cleared-tool-selection");

function parseToolSelectionData(data: unknown): string[] | typeof CLEARED | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const candidate = data as { version?: unknown; tools?: unknown; cleared?: unknown };
  if (candidate.version !== 1) return undefined;
  if (candidate.cleared === true) return CLEARED;
  if (
    !Array.isArray(candidate.tools)
    || candidate.tools.some((tool) => typeof tool !== "string" || !BUILTIN_TOOL_NAMES.has(tool))
  ) return undefined;
  return [...new Set(candidate.tools as string[])];
}

/** Return the newest valid persisted selection. Undefined identifies legacy sessions. */
export function readSessionToolSelection(entries: readonly SessionEntry[]): string[] | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== TOOL_SELECTION_TYPE) continue;
    const parsed = parseToolSelectionData(entry.data);
    if (parsed === CLEARED) return undefined;
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** True when the newest selection entry explicitly returns to configured defaults. */
export function isSessionToolSelectionCleared(entries: readonly SessionEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== TOOL_SELECTION_TYPE) continue;
    const parsed = parseToolSelectionData(entry.data);
    if (parsed === CLEARED) return true;
    if (parsed !== undefined) return false;
  }
  return false;
}

export function validateSessionToolSelection(tools: unknown): string[] {
  const parsed = parseToolSelectionData({ version: 1, tools });
  if (parsed === undefined || parsed === CLEARED) {
    throw new Error("toolNames must contain only built-in tool names");
  }
  return parsed;
}

export function appendSessionToolSelection(
  sessionManager: SessionManager,
  tools: readonly string[],
): void {
  sessionManager.appendCustomEntry(TOOL_SELECTION_TYPE, {
    version: 1,
    tools: [...tools],
  } satisfies SessionToolSelectionData);
}

/** Retract a pin so the session follows settings.json `defaultTools` again. */
export function appendClearedSessionToolSelection(sessionManager: SessionManager): void {
  sessionManager.appendCustomEntry(TOOL_SELECTION_TYPE, {
    version: 1,
    cleared: true,
  } satisfies ClearedSessionToolSelectionData);
}
