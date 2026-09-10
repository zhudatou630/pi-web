import type { SessionInfo } from "./types";
import { getSessionDisplayTitle } from "./session-display-title";
export { getSessionDisplayTitle };

export type ChatPane = "primary" | "secondary";

export interface ChatTabItem {
  id: string;
  kind: "session" | "draft";
  title: string;
  session: SessionInfo | null;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  projectKey?: string | null;
  dirty?: boolean;
  /** Group ownership is independent of which tab is currently visible. */
  pane?: ChatPane;
  /** Preview tabs are transient: sidebar single-clicks swap their content; every other
   *  tab-creation path produces non-preview (pinned) tabs. */
  preview?: boolean;
  /** Stable ChatWindow identity. Frozen when a draft is promoted so the in-flight session is not remounted. */
  mountKey?: string;
}

export function chatTabMountKey(tab: Pick<ChatTabItem, "id" | "mountKey">): string {
  return tab.mountKey ?? tab.id;
}

export function chatTabCwd(tab: ChatTabItem | null | undefined): string | null {
  if (!tab) return null;
  return tab.kind === "session" ? tab.session?.cwd ?? null : tab.newSessionCwd;
}

export function getDraftTabTitle(value: string, defaultTitle: string): string {
  const firstLine = value.split(/\r?\n/).find((line) => line.trim())?.trim();
  if (!firstLine) return defaultTitle;
  const characters = Array.from(firstLine);
  return characters.length <= 48 ? firstLine : `${characters.slice(0, 47).join("")}…`;
}

export function chatTabPane(tab: ChatTabItem): ChatPane {
  return tab.pane ?? "primary";
}

export function chatTabsInPane(tabs: ChatTabItem[], pane: ChatPane): ChatTabItem[] {
  return tabs.filter((tab) => chatTabPane(tab) === pane);
}

/** Single-click replaces only the target group's preview, in place.
 * Existing sessions are reused in their own group; pinned tabs and drafts survive. */
export function openSessionPreview(
  tabs: ChatTabItem[],
  session: SessionInfo,
  pane: ChatPane = "primary",
): { tabs: ChatTabItem[]; tabId: string } {
  const existingIndex = tabs.findIndex((t) => t.id === session.id);
  const title = getSessionDisplayTitle(session);

  if (existingIndex >= 0) {
    const nextTabs = [...tabs];
    nextTabs[existingIndex] = {
      ...nextTabs[existingIndex],
      session,
      title,
      projectKey: session.projectKey ?? session.cwd,
    };
    return { tabs: nextTabs, tabId: session.id };
  }

  const previewIndex = tabs.findIndex((t) => t.preview === true && chatTabPane(t) === pane);
  if (previewIndex >= 0) {
    const nextTabs = [...tabs];
    nextTabs[previewIndex] = {
      id: session.id,
      kind: "session",
      title,
      session,
      newSessionCwd: null,
      newSessionDraftKey: null,
      projectKey: session.projectKey ?? session.cwd,
      preview: true,
      pane,
    };
    return { tabs: nextTabs, tabId: session.id };
  }

  const newTab: ChatTabItem = {
    id: session.id,
    kind: "session",
    title,
    session,
    newSessionCwd: null,
    newSessionDraftKey: null,
    projectKey: session.projectKey ?? session.cwd,
    preview: true,
    pane,
  };
  return { tabs: [...tabs, newTab], tabId: session.id };
}

/** 双击固定 / 发送转正：清掉已有标签的 preview 标志，不改 id 与 mountKey。 */
export function pinSessionTab(tabs: ChatTabItem[], sessionId: string): ChatTabItem[] {
  const index = tabs.findIndex((t) => t.id === sessionId);
  if (index === -1 || tabs[index].preview !== true) return tabs;
  const nextTabs = [...tabs];
  nextTabs[index] = { ...nextTabs[index], preview: false };
  return nextTabs;
}

/** Reveal an existing tab in its group, or open a new one in the focused group. */
export function revealSessionPane(
  tabs: ChatTabItem[],
  sessionId: string,
  focusedPane: ChatPane,
): { activeChatTabId?: string; splitChatTabId?: string; pane: ChatPane } {
  const existing = tabs.find((tab) => tab.id === sessionId);
  const pane = existing ? chatTabPane(existing) : focusedPane;
  return pane === "secondary"
    ? { splitChatTabId: sessionId, pane }
    : { activeChatTabId: sessionId, pane };
}

/** Explicit merge: left order followed by right order, retaining every tab.
 * Keep the focused preview (or the first preview); pin other previews. */
export function mergeChatTabPanes(tabs: ChatTabItem[], focusedTabId: string | null): ChatTabItem[] {
  const ordered = [...chatTabsInPane(tabs, "primary"), ...chatTabsInPane(tabs, "secondary")];
  const preview = ordered.find((tab) => tab.id === focusedTabId && tab.preview)
    ?? ordered.find((tab) => tab.preview);
  return ordered.map((tab) => ({
    ...tab,
    pane: "primary",
    preview: tab.preview === true ? tab.id === preview?.id : tab.preview,
  }));
}

/**
 * 显式在新标签中打开（中键 / 双击固定 / “在新标签打开”）：
 * 若已打开则固定并切换过去；若未打开则在末尾追加新 Tab。
 */
export function openSessionInNewTab(
  tabs: ChatTabItem[],
  session: SessionInfo,
  pane: ChatPane = "primary",
): { tabs: ChatTabItem[]; tabId: string } {
  const existingIndex = tabs.findIndex((t) => t.id === session.id);
  const title = getSessionDisplayTitle(session);

  if (existingIndex >= 0) {
    const nextTabs = [...tabs];
    nextTabs[existingIndex] = {
      ...nextTabs[existingIndex],
      session,
      title,
      projectKey: session.projectKey ?? session.cwd,
      preview: false,
    };
    return { tabs: nextTabs, tabId: session.id };
  }

  const newTab: ChatTabItem = {
    id: session.id,
    kind: "session",
    title,
    session,
    newSessionCwd: null,
    newSessionDraftKey: null,
    projectKey: session.projectKey ?? session.cwd,
    pane,
  };
  return { tabs: [...tabs, newTab], tabId: session.id };
}

export function openDraftInTabs(
  tabs: ChatTabItem[],
  cwd: string | null,
  draftKey: string,
  defaultTitle = "新会话",
  pane: ChatPane = "primary",
): { tabs: ChatTabItem[]; tabId: string } {
  const draftId = `draft:${draftKey}`;
  const existing = tabs.find((t) => t.id === draftId);
  if (existing) {
    return { tabs, tabId: draftId };
  }

  const newTab: ChatTabItem = {
    id: draftId,
    kind: "draft",
    title: defaultTitle,
    session: null,
    newSessionCwd: cwd,
    newSessionDraftKey: draftKey,
    projectKey: cwd,
    dirty: false,
    pane,
  };
  return { tabs: [...tabs, newTab], tabId: draftId };
}

export function closeChatTab(
  tabs: ChatTabItem[],
  tabIdToClose: string,
  activeTabId: string,
  splitTabId: string | null = null,
): {
  tabs: ChatTabItem[];
  nextActiveTabId: string | null;
  nextSplitTabId: string | null;
} {
  const closeIndex = tabs.findIndex((t) => t.id === tabIdToClose);
  if (closeIndex === -1) {
    return { tabs, nextActiveTabId: activeTabId, nextSplitTabId: splitTabId };
  }

  const remaining = tabs.filter((t) => t.id !== tabIdToClose);
  const closingPane = chatTabPane(tabs[closeIndex]);
  const groupBefore = chatTabsInPane(tabs, closingPane);
  const groupAfter = chatTabsInPane(remaining, closingPane);
  const adjacentId = groupAfter[Math.min(groupBefore.findIndex((t) => t.id === tabIdToClose), groupAfter.length - 1)]?.id ?? null;

  const nextActiveTabId = tabIdToClose === activeTabId ? adjacentId : activeTabId;
  const nextSplitTabId = tabIdToClose === splitTabId ? adjacentId : splitTabId;

  // An empty group collapses; it never borrows a tab from the other group.
  if (splitTabId && groupAfter.length === 0) {
    const retainedId = closingPane === "primary" ? nextSplitTabId : nextActiveTabId;
    return {
      tabs: mergeChatTabPanes(remaining, retainedId),
      nextActiveTabId: retainedId,
      nextSplitTabId: null,
    };
  }

  return { tabs: remaining, nextActiveTabId, nextSplitTabId };
}

export function promoteDraftToSession(
  tabs: ChatTabItem[],
  draftTabId: string,
  session: SessionInfo,
): { tabs: ChatTabItem[]; newTabId: string } {
  const title = getSessionDisplayTitle(session);
  const nextTabs = tabs.map((tab) => {
    if (tab.id === draftTabId) {
      return {
        ...tab,
        id: session.id,
        kind: "session" as const,
        title,
        session,
        newSessionCwd: null,
        newSessionDraftKey: null,
        projectKey: session.projectKey ?? session.cwd,
        mountKey: tab.mountKey ?? tab.id,
      };
    }
    return tab;
  });

  return { tabs: nextTabs, newTabId: session.id };
}
