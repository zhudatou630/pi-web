import type { SessionInfo } from "./types";
import { getSessionDisplayTitle } from "./session-display-title";
export { getSessionDisplayTitle };

export interface ChatTabItem {
  id: string;
  kind: "session" | "draft";
  title: string;
  session: SessionInfo | null;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  projectKey?: string | null;
}

/**
 * 普通单击会话：在当前 Tab 就地替换查看（In-place replace / reuse），不增加新 Tab。
 * 如果该 session 已经在某个 Tab 打开，则直接切换到该 Tab。
 */
export function viewSessionInCurrentTab(
  tabs: ChatTabItem[],
  session: SessionInfo,
  currentTabId: string | null,
): { tabs: ChatTabItem[]; tabId: string } {
  const existingIndex = tabs.findIndex((t) => t.id === session.id);
  const title = getSessionDisplayTitle(session);

  // 1. 如果该 session 已经在一个 Tab 中打开了，直接复用该 Tab，并更新最新元数据
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

  // 2. 如果当前有处于活动状态的 Tab，就地替换当前 Tab，标签总数不增加！
  if (currentTabId) {
    const currentIndex = tabs.findIndex((t) => t.id === currentTabId);
    if (currentIndex >= 0) {
      const nextTabs = [...tabs];
      nextTabs[currentIndex] = {
        id: session.id,
        kind: "session",
        title,
        session,
        newSessionCwd: null,
        newSessionDraftKey: null,
        projectKey: session.projectKey ?? session.cwd,
      };
      return { tabs: nextTabs, tabId: session.id };
    }
  }

  // 3. 如果当前没有任何 Tab，创建一个新 Tab
  const newTab: ChatTabItem = {
    id: session.id,
    kind: "session",
    title,
    session,
    newSessionCwd: null,
    newSessionDraftKey: null,
    projectKey: session.projectKey ?? session.cwd,
  };
  return { tabs: [newTab], tabId: session.id };
}

/**
 * 显式在新标签中打开（中键点击 / 右键菜单“在新标签打开”）：
 * 若已打开则切换过去；若未打开则在末尾追加新 Tab。
 */
export function openSessionInNewTab(
  tabs: ChatTabItem[],
  session: SessionInfo,
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

  // 如果当前只有一个尚未输入的空草稿 Tab，替换掉它
  if (tabs.length === 1 && tabs[0].kind === "draft") {
    const newTab: ChatTabItem = {
      id: session.id,
      kind: "session",
      title,
      session,
      newSessionCwd: null,
      newSessionDraftKey: null,
      projectKey: session.projectKey ?? session.cwd,
    };
    return { tabs: [newTab], tabId: session.id };
  }

  const newTab: ChatTabItem = {
    id: session.id,
    kind: "session",
    title,
    session,
    newSessionCwd: null,
    newSessionDraftKey: null,
    projectKey: session.projectKey ?? session.cwd,
  };
  return { tabs: [...tabs, newTab], tabId: session.id };
}

/** 向后兼容别名 */
export const openSessionInTabs = openSessionInNewTab;

export function openDraftInTabs(
  tabs: ChatTabItem[],
  cwd: string | null,
  draftKey: string,
  defaultTitle = "新会话",
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

  const nextTabs = tabs.filter((t) => t.id !== tabIdToClose);

  let nextActiveTabId: string | null = activeTabId;
  let nextSplitTabId: string | null = splitTabId;

  // If closing the active tab in primary pane, pick the adjacent one
  if (tabIdToClose === activeTabId) {
    if (nextTabs.length === 0) {
      nextActiveTabId = null;
    } else {
      const newIndex = Math.min(closeIndex, nextTabs.length - 1);
      nextActiveTabId = nextTabs[newIndex].id;
    }
  }

  // If closing the tab shown in the split pane
  if (tabIdToClose === splitTabId) {
    const availableForSplit = nextTabs.filter((t) => t.id !== nextActiveTabId);
    if (availableForSplit.length > 0) {
      nextSplitTabId = availableForSplit[0].id;
    } else {
      nextSplitTabId = null;
    }
  }

  // If primary and secondary would become the same, close split
  if (nextSplitTabId && nextSplitTabId === nextActiveTabId) {
    const other = nextTabs.find((t) => t.id !== nextActiveTabId);
    nextSplitTabId = other ? other.id : null;
  }

  return {
    tabs: nextTabs,
    nextActiveTabId,
    nextSplitTabId,
  };
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
        id: session.id,
        kind: "session" as const,
        title,
        session,
        newSessionCwd: null,
        newSessionDraftKey: null,
        projectKey: session.projectKey ?? session.cwd,
      };
    }
    return tab;
  });

  return { tabs: nextTabs, newTabId: session.id };
}
