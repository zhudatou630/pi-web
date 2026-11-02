import type { FileViewerState } from "@/lib/file-viewer-state";
import type { Tab } from "./TabBar";

interface OpenFileTabInput {
  cwd?: string;
  fileName: string;
  filePath: string;
  modeHint?: "diff";
  /** PDF page to open, from a `#page=` link fragment. */
  page?: number;
  preview?: boolean;
  sourceSessionId?: string | null;
  tabId: string;
}

export function openFileTab(tabs: Tab[], input: OpenFileTabInput): Tab[] {
  const existing = tabs.find((tab) => tab.id === input.tabId);
  if (!existing) {
    const nextTab: Tab = {
      id: input.tabId,
      label: input.fileName,
      filePath: input.filePath,
      cwd: input.cwd,
      sourceSessionId: input.sourceSessionId,
      initialDisplayMode: input.modeHint,
      ...(input.page !== undefined ? { pdfPage: input.page } : {}),
      viewerState: input.modeHint ? {
        displayMode: input.modeHint,
        scrollTop: 0,
        scrollLeft: 0,
      } : undefined,
      preview: input.preview ?? false,
      viewerRevision: 0,
    };
    const previewIndex = input.preview ? tabs.findIndex((tab) => tab.preview) : -1;
    return previewIndex === -1 ? [...tabs, nextTab]
      : tabs.map((tab, index) => index === previewIndex ? nextTab : tab);
  }

  const sourceChanged = Boolean(
    input.sourceSessionId && existing.sourceSessionId !== input.sourceSessionId,
  );
  const cwdChanged = Boolean(input.cwd && existing.cwd !== input.cwd);
  // Opening a different page of the same file must remount the viewer, because
  // the page lives in the iframe URL.
  // Opening a different page of the same file must remount the viewer, because the
  // page lives in the iframe URL. A plain open (no fragment) clears any page the tab
  // was left on, so opening the same PDF from the file tree returns to page 1.
  const pageChanged = (input.page ?? undefined) !== existing.pdfPage;
  const pinPreview = existing.preview && !input.preview;
  if (!sourceChanged && !cwdChanged && !input.modeHint && !pageChanged && !pinPreview) return tabs;

  return tabs.map((tab) => {
    if (tab.id !== input.tabId) return tab;
    const next: Tab = { ...tab };
    if (pinPreview) next.preview = false;
    if (sourceChanged) next.sourceSessionId = input.sourceSessionId;
    if (cwdChanged) next.cwd = input.cwd;
    if (pageChanged) {
      next.pdfPage = input.page;
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    }
    if (input.modeHint) {
      next.initialDisplayMode = input.modeHint;
      next.viewerState = {
        displayMode: input.modeHint,
        ...(tab.viewerState?.wrapLines !== undefined ? { wrapLines: tab.viewerState.wrapLines } : {}),
        scrollTop: 0,
        scrollLeft: 0,
        loadedBytes: tab.viewerState?.loadedBytes,
        scrollByMode: {
          ...tab.viewerState?.scrollByMode,
          diff: { scrollTop: 0, scrollLeft: 0 },
        },
      };
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    } else if (sourceChanged || cwdChanged) {
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    }
    return next;
  });
}

export function saveFileViewerState(
  tabs: Tab[],
  tabId: string,
  viewerRevision: number,
  viewerState: FileViewerState,
): Tab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1 || (tabs[index].viewerRevision ?? 0) !== viewerRevision) return tabs;

  const next = [...tabs];
  next[index] = { ...next[index], viewerState };
  return next;
}

export function pinFileTab(tabs: Tab[], tabId: string): Tab[] {
  if (!tabs.some((tab) => tab.id === tabId && tab.preview)) return tabs;
  return tabs.map((tab) => tab.id === tabId ? { ...tab, preview: false } : tab);
}

export const FILE_TABS_KEY = "pi-file-tabs";

/** File tabs are one list for the whole window, independent of the sidebar's project. */
export interface StoredFileTabs {
  tabs: Tab[];
  activeTabId: string | null;
  open: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readViewerState(value: unknown): FileViewerState | undefined {
  if (!isRecord(value) || !["source", "preview", "diff"].includes(value.displayMode as string)
    || (value.wrapLines !== undefined && typeof value.wrapLines !== "boolean") || !isOffset(value.scrollTop) || !isOffset(value.scrollLeft)
    || (value.loadedBytes !== undefined && !isOffset(value.loadedBytes))) return undefined;
  const scrollByMode: FileViewerState["scrollByMode"] = {};
  if (value.scrollByMode !== undefined) {
    if (!isRecord(value.scrollByMode)) return undefined;
    for (const mode of ["source", "preview", "diff"] as const) {
      const offset = value.scrollByMode[mode];
      if (offset === undefined) continue;
      if (!isRecord(offset) || !isOffset(offset.scrollTop) || !isOffset(offset.scrollLeft)) return undefined;
      scrollByMode[mode] = { scrollTop: offset.scrollTop, scrollLeft: offset.scrollLeft };
    }
  }
  return {
    displayMode: value.displayMode as FileViewerState["displayMode"],
    ...(typeof value.wrapLines === "boolean" ? { wrapLines: value.wrapLines } : {}),
    scrollTop: value.scrollTop,
    scrollLeft: value.scrollLeft,
    ...(value.loadedBytes !== undefined ? { loadedBytes: value.loadedBytes as number } : {}),
    ...(value.scrollByMode !== undefined ? { scrollByMode } : {}),
  };
}

// Whitelist metadata: never persist file contents, even if a caller adds fields.
export function serializeFileTabs(state: StoredFileTabs): string {
  return JSON.stringify({
    version: 2,
    activeTabId: state.activeTabId,
    open: state.open,
    tabs: state.tabs.map((tab) => ({
      id: tab.id, label: tab.label, filePath: tab.filePath, cwd: tab.cwd,
      sourceSessionId: tab.sourceSessionId, initialDisplayMode: tab.initialDisplayMode,
      pdfPage: tab.pdfPage, preview: tab.preview, viewerRevision: tab.viewerRevision,
      viewerState: readViewerState(tab.viewerState),
    })),
  });
}

function readStoredTab(value: unknown): Tab | null {
  if (!isRecord(value) || typeof value.filePath !== "string" || !value.filePath
    || value.id !== `file:${value.filePath}` || typeof value.label !== "string"
    || (value.cwd !== undefined && typeof value.cwd !== "string")
    || (value.sourceSessionId !== undefined && value.sourceSessionId !== null && typeof value.sourceSessionId !== "string")
    || (value.preview !== undefined && typeof value.preview !== "boolean")
    || (value.initialDisplayMode !== undefined && !["source", "preview", "diff"].includes(value.initialDisplayMode as string))
    || (value.pdfPage !== undefined && (!isOffset(value.pdfPage) || !Number.isInteger(value.pdfPage) || value.pdfPage < 1))
    || (value.viewerRevision !== undefined && (!isOffset(value.viewerRevision) || !Number.isInteger(value.viewerRevision)))
    || (value.viewerState !== undefined && !readViewerState(value.viewerState))) return null;
  return {
    id: value.id, label: value.label, filePath: value.filePath,
    cwd: value.cwd as Tab["cwd"], sourceSessionId: value.sourceSessionId as Tab["sourceSessionId"],
    preview: value.preview as Tab["preview"], initialDisplayMode: value.initialDisplayMode as Tab["initialDisplayMode"],
    pdfPage: value.pdfPage as Tab["pdfPage"], viewerRevision: value.viewerRevision as Tab["viewerRevision"],
    viewerState: readViewerState(value.viewerState),
  };
}

/** Malformed tabs are dropped one by one; an unknown payload restores nothing. */
export function restoreFileTabs(raw: string | null): StoredFileTabs {
  const empty: StoredFileTabs = { tabs: [], activeTabId: null, open: false };
  try {
    const saved: unknown = JSON.parse(raw ?? "null");
    if (!isRecord(saved) || saved.version !== 2 || !Array.isArray(saved.tabs)) return empty;
    const tabs: Tab[] = [];
    for (const value of saved.tabs) {
      const tab = readStoredTab(value);
      if (!tab || tabs.some((existing) => existing.id === tab.id)) continue;
      // Only one preview tab: later ones are kept as pinned.
      tabs.push(tab.preview && tabs.some((existing) => existing.preview) ? { ...tab, preview: false } : tab);
    }
    const activeTabId = tabs.some((tab) => tab.id === saved.activeTabId) ? saved.activeTabId as string : null;
    return { tabs, activeTabId, open: activeTabId !== null && saved.open === true };
  } catch {
    return empty;
  }
}

export function mergeFileViewerStates(
  tabs: Tab[],
  states: Map<string, { viewerRevision: number; viewerState: FileViewerState }>,
): Tab[] {
  return tabs.map((tab) => {
    const latest = states.get(tab.id);
    return latest && latest.viewerRevision === (tab.viewerRevision ?? 0)
      ? { ...tab, viewerState: latest.viewerState } : tab;
  });
}

export const PANEL_TAB_ORDER_KEY = "pi-web:panel-tab-order";

/** Files and terminals live in separate lists; `order` is the user's drag order across both. Unlisted tabs follow in natural order. */
export function orderPanelTabs(tabs: Tab[], order: readonly string[]): Tab[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  const ranked = tabs.filter((tab) => rank.has(tab.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...ranked, ...tabs.filter((tab) => !rank.has(tab.id))];
}

/** Moves `tabId` before `beforeId` (null = end). Dropping a tab onto itself changes nothing. */
export function movePanelTab(ids: readonly string[], tabId: string, beforeId: string | null): string[] {
  const rest = ids.filter((id) => id !== tabId);
  const index = beforeId === null ? rest.length : rest.indexOf(beforeId);
  if (index < 0 || rest.length === ids.length) return [...ids];
  return [...rest.slice(0, index), tabId, ...rest.slice(index)];
}

/** A tab replaced in place (preview swap, terminal restart) keeps its dragged position. */
export function replacePanelTabId(order: readonly string[], oldId: string, newId: string): string[] {
  return order.map((id) => id === oldId ? newId : id);
}

export function restorePanelTabOrder(raw: string | null): string[] {
  try {
    const saved: unknown = JSON.parse(raw ?? "null");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function getAdjacentTabId(tabs: Tab[], closingId: string): string | null {
  const closingIndex = tabs.findIndex((tab) => tab.id === closingId);
  if (closingIndex === -1) return null;
  const remaining = tabs.filter((tab) => tab.id !== closingId);
  return remaining[Math.min(closingIndex, remaining.length - 1)]?.id ?? null;
}
