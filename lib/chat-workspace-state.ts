import { chatTabPane, mergeChatTabPanes, openSessionInNewTab, type ChatPane, type ChatTabItem } from "./chat-tab-state";
import { getSessionDisplayTitle } from "./session-display-title";
import type { SessionInfo } from "./types";

export const CHAT_WORKSPACE_STORAGE_KEY = "pi-chat-workspace";
export interface ChatWorkspace {
  tabs: ChatTabItem[];
  activeId: string | null;
  splitId: string | null;
  focusedPane: ChatPane;
  splitRatio: number;
}

/** Store identities and layout only, never transcript contents or copies of the catalog. */
export function serializeChatWorkspace(state: ChatWorkspace): string {
  return JSON.stringify({ ...state, version: 1, tabs: state.tabs.map((tab) => ({
    id: tab.id, kind: tab.kind, pane: chatTabPane(tab), preview: tab.preview,
    ...(tab.kind === "draft" ? { title: tab.title, cwd: tab.newSessionCwd, draftKey: tab.newSessionDraftKey, dirty: tab.dirty } : {}),
  })) });
}

export function restoreChatWorkspace(raw: string | null, sessions: readonly SessionInfo[], urlSessionId: string | null): ChatWorkspace | null {
  let saved;
  try { saved = JSON.parse(raw ?? "null"); } catch { return null; }
  if (saved?.version !== 1 || !Array.isArray(saved.tabs)) return null;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const seen = new Set<string>();
  const previews = new Set<ChatPane>();
  let tabs: ChatTabItem[] = [];
  for (const item of saved.tabs) {
    if (typeof item?.id !== "string" || seen.has(item.id)) continue;
    const pane = item.pane === "secondary" ? "secondary" : "primary";
    let tab: ChatTabItem;
    if (item.kind === "session") {
      const session = byId.get(item.id);
      if (!session) continue;
      tab = { id: session.id, kind: "session", title: getSessionDisplayTitle(session), session, newSessionCwd: null, newSessionDraftKey: null, projectKey: session.projectKey ?? session.cwd, pane, preview: item.preview === true && !previews.has(pane) };
      if (tab.preview) previews.add(pane);
    } else if (item.kind === "draft" && typeof item.draftKey === "string" && item.id === `draft:${item.draftKey}`) {
      tab = { id: item.id, kind: "draft", title: typeof item.title === "string" ? item.title : "", session: null, newSessionCwd: typeof item.cwd === "string" ? item.cwd : null, newSessionDraftKey: item.draftKey, pane, dirty: item.dirty === true };
    } else continue;
    seen.add(tab.id);
    tabs.push(tab);
  }
  let activeId = tabs.find((tab) => tab.id === saved.activeId && chatTabPane(tab) === "primary")?.id
    ?? tabs.find((tab) => chatTabPane(tab) === "primary")?.id ?? null;
  let splitId = tabs.find((tab) => tab.id === saved.splitId && chatTabPane(tab) === "secondary")?.id
    ?? tabs.find((tab) => chatTabPane(tab) === "secondary")?.id ?? null;
  let focusedPane: ChatPane = saved.focusedPane === "secondary" && splitId ? "secondary" : "primary";
  if (!activeId || !splitId) {
    tabs = mergeChatTabPanes(tabs, activeId ?? splitId);
    activeId ??= splitId;
    splitId = null;
    focusedPane = "primary";
  }
  // An explicit link wins focus, but does not replace another group's preview.
  const linked = urlSessionId ? byId.get(urlSessionId) : undefined;
  if (linked) {
    if (!seen.has(linked.id)) tabs = openSessionInNewTab(tabs, linked).tabs;
    focusedPane = chatTabPane(tabs.find((tab) => tab.id === linked.id)!);
    if (focusedPane === "secondary") splitId = linked.id;
    else activeId = linked.id;
  }
  return { tabs, activeId, splitId, focusedPane, splitRatio: typeof saved.splitRatio === "number" && Number.isFinite(saved.splitRatio) ? Math.max(0.2, Math.min(0.8, saved.splitRatio)) : 0.5 };
}
