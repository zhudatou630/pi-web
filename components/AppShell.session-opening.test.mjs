import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const viewState = await jiti.import("../lib/chat-view-state.ts");
const { EMPTY_CHAT_VIEW, sessionItem, showInPane } = viewState;
const source = ts.createSourceFile("AppShell.tsx", await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}
function execute(node, scope) {
  return new Script(ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(scope);
}
function callback(name, scope) {
  const declaration = find(source, (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.ok(declaration, name);
  return execute(declaration.initializer.arguments[0], scope);
}
function boundAction(component, prop, scope) {
  const element = find(source, (node) => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === component);
  const attribute = element.attributes.properties.find((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === prop);
  return execute(attribute.initializer.expression, scope);
}

const never = () => false;
const viewOf = (...sessions) => sessions.reduce((view, [session, pane = "primary"]) => showInPane(view, sessionItem(session), pane, never).view, EMPTY_CHAT_VIEW);

/** handleSelectSession and its family, run against a fake AppShell scope. */
function shellScope({ view, selectedSession, split = false, isMobile = false, activeCwd = "/repo", activeProjectKey = "/repo", result }) {
  const scope = {
    ...viewState,
    selectedSession, activeCwd, newSessionCwd: null, activeFileTabId: "file:/repo/code.ts", isMobile,
    canSplitChat: !isMobile, mainView: "chat", fallbackDraftRef: { current: null },
    activeNewSessionDraftKeyRef: { current: null }, activeProjectKeyRef: { current: activeProjectKey },
    chatViewRef: { current: view }, isSplitActiveRef: { current: split }, canSplitChatRef: { current: !isMobile },
    branchLeafChangeFnRef: { current: null }, suppressCwdBumpRef: { current: false },
    activeSessionIdRef: { current: selectedSession?.id ?? null },
    keepMounted: never,
    commitChatView({ view: next }) { scope.chatViewRef.current = next; },
    handleSessionForked(...args) { result.besideArgs = args; },
    closeTopPanel(restoreFocus) { result.closedTopPanel = restoreFocus; },
    workspaceKeyOf: (item) => item.projectKey ?? item.projectRoot ?? item.cwd,
    router: { replace(url) { result.url = url; } },
    syncSessionMetadata(id) { result.metadata = id; },
    rekeyDraft() { assert.fail("session selection must not rekey a draft"); },
    parkedNewSessionDraftKey: (cwd) => `parked-new:${cwd}`,
  };
  for (const setter of ["SearchTarget", "FileTabs", "ActiveFileTabId", "RightPanelOpen", "ActiveTopPanel", "NewSessionCwd", "SelectedSession", "SessionKey", "BranchTree", "BranchActiveLeafId", "SystemPrompt", "SystemTools", "SystemInfoLoading", "SidebarOpen", "MainView", "SessionStats", "ContextUsage"]) {
    scope[`set${setter}`] = (value) => { result[setter] = value; };
  }
  scope.syncFocusedChatItem = callback("syncFocusedChatItem", scope);
  scope.handleSelectSession = callback("handleSelectSession", scope);
  scope.handleOpenInSplit = callback("handleOpenInSplit", scope);
  scope.handleSwitchFamilySession = callback("handleSwitchFamilySession", scope);
  scope.handleSelectFamilySession = callback("handleSelectFamilySession", scope);
  return scope;
}

for (const [component, prop] of [["SessionSidebar", "onOpenSessionInSplit"], ["AgentSessionPanel", "onOpenInSplit"]]) {
  test(`${component}.${prop} opens the session in the right pane through full selection cleanup`, () => {
    const session = { id: "target", name: "Target", cwd: "/new-project", projectKey: "/new-project" };
    const primary = { id: "primary", cwd: "/old-project", projectKey: "/old-project" };
    const result = {};
    const scope = shellScope({ view: viewOf([primary]), selectedSession: primary, activeProjectKey: "/old-project", result });
    boundAction(component, prop, scope)(session);

    const view = scope.chatViewRef.current;
    assert.deepEqual([view.primaryId, view.secondaryId, view.focusedPane], ["primary", "target", "secondary"]);
    assert.equal(result.SelectedSession, session);
    assert.equal(result.SearchTarget, null);
    assert.equal(result.FileTabs, undefined);
    assert.equal(result.RightPanelOpen, undefined);
    assert.equal(result.SidebarOpen, undefined);
    assert.equal(result.metadata, "target");
    assert.equal(result.url, "?session=target");
    assert.equal(result.MainView, "chat", "opening a session leaves the Routines view");
    assert.equal(scope.activeProjectKeyRef.current, "/new-project");
  });

  test(`${component}.${prop} is absent where the chat cannot split`, () => {
    const primary = { id: "primary", cwd: "/repo" };
    const scope = shellScope({ view: viewOf([primary]), selectedSession: primary, isMobile: true, result: {} });
    assert.equal(boundAction(component, prop, scope), undefined);
  });
}

test("a sidebar pick replaces the focused pane, keeps the other pane and caches the replaced session", () => {
  const session = { id: "target", name: "Target", cwd: "/repo", projectKey: "/repo" };
  const left = { id: "left", cwd: "/repo", projectKey: "/repo" };
  const right = { id: "right", cwd: "/repo", projectKey: "/repo" };
  const result = {};
  const scope = shellScope({ view: viewOf([left], [right, "secondary"]), selectedSession: right, split: true, result });
  boundAction("SessionSidebar", "onSelectSession", scope)(session);
  const view = scope.chatViewRef.current;
  assert.deepEqual([view.primaryId, view.secondaryId, view.focusedPane], ["left", "target", "secondary"]);
  assert.deepEqual(view.items.map((item) => item.id), ["left", "right", "target"]);
  assert.equal(result.url, "?session=target");
});

test("picking the session the other pane shows only moves focus there", () => {
  const left = { id: "left", cwd: "/repo", projectKey: "/repo" };
  const right = { id: "right", cwd: "/repo", projectKey: "/repo" };
  const result = {};
  const scope = shellScope({ view: viewOf([left], [right, "secondary"]), selectedSession: right, split: true, result });
  scope.handleSelectSession(left);
  const view = scope.chatViewRef.current;
  assert.deepEqual([view.primaryId, view.secondaryId, view.focusedPane], ["left", "right", "primary"]);
  assert.equal(result.SelectedSession, left);
  assert.equal(result.SessionKey, undefined, "no reload of an on-screen session");
  assert.equal(result.url, "?session=left");
});

test("AgentSessionPanel.onSelectSession opens a side chat beside the current chat, or focuses the pane showing it", () => {
  const side = { id: "side", name: "Side: why", cwd: "/repo", projectKey: "/repo", relation: { kind: "side", parentSessionId: "primary" } };
  const primary = { id: "primary", name: "Main", cwd: "/repo", projectKey: "/repo" };
  const result = {};
  const scope = shellScope({ view: viewOf([primary]), selectedSession: primary, result });
  boundAction("AgentSessionPanel", "onSelectSession", scope)(side);
  assert.deepEqual(result.besideArgs, ["side", "primary", side, "primary", true]);
  assert.equal(result.closedTopPanel, true, "a pick closes the panel and returns focus to its trigger");

  const open = {};
  const openScope = shellScope({ view: viewOf([primary], [side, "secondary"]), selectedSession: primary, split: true, result: open });
  boundAction("AgentSessionPanel", "onSelectSession", openScope)(side);
  assert.equal(open.besideArgs, undefined);
  assert.equal(openScope.chatViewRef.current.focusedPane, "secondary");
});

test("AgentSessionPanel.onSelectSession replaces the current pane in place", () => {
  const session = { id: "child", name: "Child", cwd: "/repo", projectKey: "/repo" };
  const primary = { id: "primary", name: "Main", cwd: "/repo", projectKey: "/repo" };
  const result = {};
  const scope = shellScope({ view: viewOf([primary]), selectedSession: primary, result });
  boundAction("AgentSessionPanel", "onSelectSession", scope)(session);
  assert.equal(scope.chatViewRef.current.primaryId, "child");
  assert.equal(result.closedTopPanel, true);
  assert.equal(result.SelectedSession, session);
  assert.equal(result.FileTabs, undefined);
  assert.equal(result.metadata, "child");
  assert.equal(result.url, "?session=child");
});

test("does not close the file reader while a session identity is still unresolved", () => {
  const session = { id: "target", name: "Target", cwd: "/repo/subdir", projectKey: "/repo" };
  const primary = { id: "primary", cwd: "/repo/subdir", transient: true };
  const result = {};
  const scope = shellScope({ view: viewOf([primary]), selectedSession: primary, activeCwd: "/repo/subdir", activeProjectKey: null, result });
  scope.handleSelectSession(session);
  assert.equal(result.FileTabs, undefined);
  assert.equal(result.ActiveFileTabId, undefined);
  assert.equal(result.RightPanelOpen, undefined);
  assert.equal(scope.activeProjectKeyRef.current, "/repo");
});

test("the view-less first composer parks its draft when replaced, and stays left when a session opens on the right", () => {
  const session = { id: "target", cwd: "/repo", projectKey: "/repo" };
  const result = {};
  const scope = shellScope({ view: EMPTY_CHAT_VIEW, selectedSession: null, result });
  scope.fallbackDraftRef.current = { key: "new:initial:/repo", cwd: "/repo" };
  const parked = [];
  scope.rekeyDraft = (from, to) => parked.push([from, to]);
  scope.handleSelectSession = callback("handleSelectSession", scope);
  scope.handleSelectSession(session);
  assert.deepEqual(parked, [["new:initial:/repo", "parked-new:/repo"]]);

  const split = shellScope({ view: EMPTY_CHAT_VIEW, selectedSession: null, result: {} });
  split.fallbackDraftRef.current = { key: "new:initial:/repo", cwd: "/repo" };
  split.handleOpenInSplit(session);
  const view = split.chatViewRef.current;
  assert.deepEqual([view.primaryId, view.secondaryId], ["draft:new:initial:/repo", "target"]);
});

test("back from Routines, re-picking the session on screen names it in the address again", () => {
  const primary = { id: "primary", cwd: "/repo", projectKey: "/repo" };
  const result = {};
  const scope = shellScope({ view: viewOf([primary]), selectedSession: primary, result });
  scope.mainView = "routines";
  scope.handleSelectSession = callback("handleSelectSession", scope);
  scope.handleSelectSession(primary);
  assert.equal(result.url, "?session=primary");
  assert.equal(result.MainView, "chat");
  assert.equal(result.SessionKey, undefined);
});
