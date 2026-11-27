import type { SessionInfo } from "./types";

/**
 * The chat area without tabs (docs/adr/0005-sidebar-as-session-switcher.md): at most two panes,
 * each showing one session or one draft's new-session page, plus a mount cache of recently shown
 * sessions so switching back is instant. Pure functions; AppShell owns the state.
 */
export type ChatPane = "primary" | "secondary";

export interface ChatViewItem {
  /** Session id, or `draft:<draftKey>`. */
  id: string;
  kind: "session" | "draft";
  session: SessionInfo | null;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  /** Stable ChatWindow identity. Frozen when a draft is promoted so the in-flight session is not remounted. */
  mountKey?: string;
}

export interface ChatView {
  /** Mounted items in mount order (never reordered: moving a node would cost its scroll position). */
  items: ChatViewItem[];
  /** Item ids, most recently shown first. */
  recent: string[];
  primaryId: string | null;
  /** Set only while split. */
  secondaryId: string | null;
  focusedPane: ChatPane;
}

/** A sidebar row dragged onto the chat area's right half opens there. */
export const SESSION_DRAG_MIME = "application/x-pi-session";

/** Hidden sessions kept mounted besides the shown and the running ones. */
export const HIDDEN_CACHE_SIZE = 5;

export const EMPTY_CHAT_VIEW: ChatView = { items: [], recent: [], primaryId: null, secondaryId: null, focusedPane: "primary" };

/**
 * Merge a session's server row into a client-held SessionInfo. The row wins
 * (a persisted row also clears `transient`); `current` comes back unchanged
 * when nothing differs, so state setters can bail out.
 */
export function mergeCatalogRow<T extends SessionInfo | null>(current: T, row: SessionInfo): T | SessionInfo {
  const merged = { ...current, ...row, transient: row.transient ?? false };
  return current && JSON.stringify(merged) === JSON.stringify(current) ? current : merged;
}

export function sessionItem(session: SessionInfo): ChatViewItem {
  return { id: session.id, kind: "session", session, newSessionCwd: null, newSessionDraftKey: null };
}

export function draftItem(draftKey: string, cwd: string | null): ChatViewItem {
  return { id: `draft:${draftKey}`, kind: "draft", session: null, newSessionCwd: cwd, newSessionDraftKey: draftKey };
}

export function chatItemMountKey(item: Pick<ChatViewItem, "id" | "mountKey">): string {
  return item.mountKey ?? item.id;
}

export function chatItemCwd(item: ChatViewItem | null | undefined): string | null {
  if (!item) return null;
  return item.kind === "session" ? item.session?.cwd ?? null : item.newSessionCwd;
}

export function shownId(view: ChatView, pane: ChatPane): string | null {
  return pane === "secondary" ? view.secondaryId : view.primaryId;
}

export function shownItem(view: ChatView, pane: ChatPane): ChatViewItem | null {
  const id = shownId(view, pane);
  return id ? view.items.find((item) => item.id === id) ?? null : null;
}

export function focusedItem(view: ChatView): ChatViewItem | null {
  return shownItem(view, view.focusedPane);
}

export function paneOf(view: ChatView, id: string): ChatPane | null {
  if (id === view.primaryId) return "primary";
  if (view.secondaryId && id === view.secondaryId) return "secondary";
  return null;
}

/** The pane already showing a draft for `cwd`: one draft per cwd, never in both panes. */
export function paneShowingDraft(view: ChatView, cwd: string | null): ChatPane | null {
  for (const pane of ["primary", "secondary"] as const) {
    const item = shownItem(view, pane);
    if (item?.kind === "draft" && item.newSessionCwd === cwd) return pane;
  }
  return null;
}

/**
 * Drop what the cache no longer holds: drafts not on screen (their text stays in the draft
 * store), and hidden sessions beyond the newest HIDDEN_CACHE_SIZE unless `keep` (running) says so.
 */
export function evictChatItems(view: ChatView, keep: (id: string) => boolean): { view: ChatView; evicted: ChatViewItem[] } {
  const shown = new Set([view.primaryId, view.secondaryId].filter(Boolean));
  const hiddenRank = new Map(view.recent
    .filter((id) => !shown.has(id) && view.items.some((item) => item.id === id && item.kind === "session"))
    .map((id, index) => [id, index]));
  const evicted: ChatViewItem[] = [];
  const items = view.items.filter((item) => {
    const kept = shown.has(item.id)
      || (item.kind === "session" && (keep(item.id) || (hiddenRank.get(item.id) ?? Infinity) < HIDDEN_CACHE_SIZE));
    if (!kept) evicted.push(item);
    return kept;
  });
  if (evicted.length === 0) return { view, evicted };
  const ids = new Set(items.map((item) => item.id));
  return { view: { ...view, items, recent: view.recent.filter((id) => ids.has(id)) }, evicted };
}

function upsert(items: ChatViewItem[], item: ChatViewItem): ChatViewItem[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = { ...item, mountKey: items[index].mountKey ?? item.mountKey };
  return next;
}

/**
 * Show an item in a pane (opening the split for "secondary") and focus it. An item the other
 * pane already shows only takes focus there: nothing is shown twice.
 */
export function showInPane(view: ChatView, item: ChatViewItem, pane: ChatPane, keep: (id: string) => boolean): { view: ChatView; evicted: ChatViewItem[] } {
  const items = upsert(view.items, item);
  const recent = [item.id, ...view.recent.filter((id) => id !== item.id)];
  const current = paneOf(view, item.id);
  const target = current ?? (pane === "secondary" && !view.primaryId ? "primary" : pane);
  const next: ChatView = {
    items,
    recent,
    primaryId: target === "primary" ? item.id : view.primaryId,
    secondaryId: target === "secondary" ? item.id : view.secondaryId,
    focusedPane: target,
  };
  return evictChatItems(next, keep);
}

export function focusPane(view: ChatView, pane: ChatPane): ChatView {
  if (view.focusedPane === pane || (pane === "secondary" && !view.secondaryId)) return view;
  return { ...view, focusedPane: pane };
}

/** End the split by closing one pane: the other becomes primary, keeps its window and takes focus. */
export function closePane(view: ChatView, pane: ChatPane, keep: (id: string) => boolean): { view: ChatView; evicted: ChatViewItem[] } {
  if (!view.secondaryId) return { view, evicted: [] };
  const survivor = pane === "primary" ? view.secondaryId : view.primaryId;
  return evictChatItems({ ...view, primaryId: survivor, secondaryId: null, focusedPane: "primary" }, keep);
}

/** A sent draft becomes its session in place: same pane, same component identity. */
export function promoteDraft(view: ChatView, draftId: string, session: SessionInfo): ChatView {
  const draft = view.items.find((item) => item.id === draftId);
  if (!draft) return view;
  const swap = (id: string | null) => id === draftId ? session.id : id;
  return {
    ...view,
    items: view.items.filter((item) => item.id !== session.id).map((item) => item.id === draftId
      ? { ...sessionItem(session), mountKey: chatItemMountKey(draft) }
      : item),
    recent: view.recent.filter((id) => id !== session.id).map((id) => id === draftId ? session.id : id),
    primaryId: swap(view.primaryId),
    secondaryId: swap(view.secondaryId),
  };
}

/** Apply a fresher SessionInfo to every copy the view holds. */
export function updateChatSession(view: ChatView, session: SessionInfo): ChatView {
  let changed = false;
  const items = view.items.map((item) => {
    if (item.id !== session.id || item.kind !== "session") return item;
    const merged = item.session ? mergeCatalogRow(item.session, session) : session;
    if (merged === item.session) return item;
    changed = true;
    return { ...item, session: merged };
  });
  return changed ? { ...view, items } : view;
}

/** A deleted session leaves the view. Shown in a split: that pane closes. Shown alone: primary is left empty for the caller to fill. */
export function removeChatSession(view: ChatView, id: string): ChatView {
  if (!view.items.some((item) => item.id === id)) return view;
  let next: ChatView = { ...view, items: view.items.filter((item) => item.id !== id), recent: view.recent.filter((recentId) => recentId !== id) };
  const pane = paneOf(view, id);
  if (pane && view.secondaryId) {
    const survivor = pane === "primary" ? view.secondaryId : view.primaryId;
    next = { ...next, primaryId: survivor, secondaryId: null, focusedPane: "primary" };
  } else if (pane === "primary") {
    next = { ...next, primaryId: null };
  }
  return next;
}

/**
 * Alt+↑/↓: the neighbour in the sidebar's displayed order, without wrapping. A current session
 * not in the list starts from the top (↓) or bottom (↑). The other pane's session is skipped:
 * picking it would only move focus.
 */
export function adjacentSessionId(order: readonly string[], currentId: string | null, direction: 1 | -1, skipId: string | null): string | null {
  const list = order.filter((id) => id !== skipId);
  const index = currentId ? list.indexOf(currentId) : -1;
  if (index < 0) return (direction > 0 ? list[0] : list[list.length - 1]) ?? null;
  return list[index + direction] ?? null;
}

/** Alt+Shift+↑/↓: the next session that needs you, in NEEDS YOU order, wrapping. */
export function nextNeedsYouId(order: readonly string[], currentId: string | null, direction: 1 | -1, skipId: string | null): string | null {
  const list = order.filter((id) => id !== skipId);
  if (list.length === 0) return null;
  const index = currentId ? list.indexOf(currentId) : -1;
  const next = index < 0
    ? (direction > 0 ? list[0] : list[list.length - 1])
    : list[(index + direction + list.length) % list.length];
  return next === currentId ? null : next;
}

export type SessionShortcut = "next" | "previous" | "nextNeedsYou" | "previousNeedsYou" | "switcher";

/**
 * Alt (Option) shortcuts; no browser binds these (ADR 0005, Conflicts checked). Ctrl or Meta
 * excludes it (AltGr reports Ctrl+Alt), as do IME composition, a terminal (Alt is the shell's
 * Meta) and an open modal (Settings › Models reorders with Alt+↑/↓). Letters match the physical
 * key: Option+K types "˚" on a Mac.
 */
export function matchSessionShortcut(event: {
  key: string; code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean;
  isComposing?: boolean; inTerminal?: boolean; modalOpen?: boolean;
}): SessionShortcut | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.inTerminal || event.modalOpen) return null;
  if (event.key === "ArrowDown") return event.shiftKey ? "nextNeedsYou" : "next";
  if (event.key === "ArrowUp") return event.shiftKey ? "previousNeedsYou" : "previous";
  if (event.code === "KeyK" && !event.shiftKey) return "switcher";
  return null;
}

// ---------------------------------------------------------------------------
// Reload: which item each pane showed, in sessionStorage (ids only, no content).

export const CHAT_VIEW_STORAGE_KEY = "pi-chat-view";
/** Tab-era keys: the workspace is dropped, draft metadata is re-keyed once (ADR 0005, Reload). */
export const LEGACY_CHAT_WORKSPACE_KEY = "pi-chat-workspace";
export const LEGACY_DRAFT_TABS_KEY = "pi-chat-draft-tabs";

type StoredItem = { kind: "session"; id: string } | { kind: "draft"; draftKey: string; cwd: string | null };

function storedItem(item: ChatViewItem | null): StoredItem | null {
  if (!item) return null;
  return item.kind === "session" ? { kind: "session", id: item.id } : { kind: "draft", draftKey: item.newSessionDraftKey ?? "", cwd: item.newSessionCwd };
}

export function serializeChatView(view: ChatView, splitRatio: number): string {
  return JSON.stringify({
    version: 1,
    primary: storedItem(shownItem(view, "primary")),
    secondary: storedItem(shownItem(view, "secondary")),
    focusedPane: view.focusedPane,
    splitRatio,
  });
}

export interface RestoredChatView {
  primary: ChatViewItem | null;
  secondary: ChatViewItem | null;
  focusedPane: ChatPane;
  splitRatio: number;
}

/**
 * Deleted sessions are dropped (a lone secondary moves left). A valid `?session=` wins focus:
 * the pane showing it, else it replaces the focused pane.
 */
export function restoreChatView(raw: string | null, sessions: readonly SessionInfo[], urlSessionId: string | null): RestoredChatView | null {
  let saved;
  try { saved = JSON.parse(raw ?? "null"); } catch { saved = null; }
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const toItem = (value: unknown): ChatViewItem | null => {
    const stored = value as Partial<StoredItem> | null;
    if (stored?.kind === "session" && typeof stored.id === "string") {
      const session = byId.get(stored.id);
      return session ? sessionItem(session) : null;
    }
    if (stored?.kind === "draft" && typeof stored.draftKey === "string" && stored.draftKey) {
      return draftItem(stored.draftKey, typeof stored.cwd === "string" ? stored.cwd : null);
    }
    return null;
  };
  const valid = saved?.version === 1;
  let primary = valid ? toItem(saved.primary) : null;
  let secondary = valid ? toItem(saved.secondary) : null;
  if (secondary && secondary.id === primary?.id) secondary = null;
  if (!primary) { primary = secondary; secondary = null; }
  let focusedPane: ChatPane = valid && saved.focusedPane === "secondary" && secondary ? "secondary" : "primary";
  const linked = urlSessionId ? byId.get(urlSessionId) : undefined;
  if (linked) {
    if (linked.id === primary?.id) focusedPane = "primary";
    else if (linked.id === secondary?.id) focusedPane = "secondary";
    else if (focusedPane === "secondary") secondary = sessionItem(linked);
    else primary = sessionItem(linked);
  }
  if (!primary) return null;
  const ratio = valid && typeof saved.splitRatio === "number" && Number.isFinite(saved.splitRatio) ? saved.splitRatio : 0.5;
  return { primary, secondary, focusedPane, splitRatio: Math.max(0.2, Math.min(0.8, ratio)) };
}

/** Tab-era unsent drafts: the first one per cwd, to be parked under that cwd's key. */
export function legacyDraftsToPark(raw: string | null): { draftKey: string; cwd: string }[] {
  let stored;
  try { stored = JSON.parse(raw ?? "[]"); } catch { return []; }
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  return stored.flatMap((item) => {
    if (typeof item?.draftKey !== "string" || typeof item?.cwd !== "string" || seen.has(item.cwd)) return [];
    seen.add(item.cwd);
    return [{ draftKey: item.draftKey, cwd: item.cwd }];
  });
}
