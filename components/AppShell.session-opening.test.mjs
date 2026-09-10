import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const tabState = await jiti.import("../lib/chat-tab-state.ts");
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

for (const [component, prop, split] of [
  ["SessionSidebar", "onPinSession"],
  ["SessionSidebar", "onOpenSessionInNewTab"],
  ["AgentSessionPanel", "onSelectSession"],
  ["AgentSessionPanel", "onOpenInNewTab"],
].flatMap(([component, prop]) => [false, true].map((split) => [component, prop, split]))) {
  test(`${component}.${prop} pins through full selection cleanup (${split ? "desktop split" : "mobile"})`, () => {
    const session = { id: "target", name: "Target", cwd: "/new-project" };
    const primary = { id: "primary", cwd: "/old-project" };
    let tabs = tabState.openSessionInNewTab([], primary).tabs;
    tabs = tabState.openSessionPreview(tabs, session, split ? "secondary" : "primary").tabs;
    const result = {};
    const scope = {
      ...tabState,
      selectedSession: primary, activeCwd: "/old-project", newSessionCwd: null,
      activeFileTabId: "file:/old-project/code.ts", isMobile: !split,
      activeNewSessionDraftKeyRef: { current: null }, activeProjectKeyRef: { current: "/old-project" },
      chatTabsRef: { current: tabs }, isSplitActiveRef: { current: split }, activeChatPaneRef: { current: "primary" },
      branchLeafChangeFnRef: { current: null }, suppressCwdBumpRef: { current: false },
      workspaceKeyOf: (session) => session.cwd,
      setChatTabs(update) { scope.chatTabsRef.current = update(scope.chatTabsRef.current); },
      router: { replace(url) { result.url = url; } },
      syncSessionMetadata(id) { result.metadata = id; },
      rekeyDraft() { assert.fail("historical session selection must not rekey a draft"); },
    };
    for (const setter of ["SearchTarget", "FileTabs", "ActiveFileTabId", "RightPanelOpen", "ActiveTopPanel", "NewSessionCwd", "SelectedSession", "ActiveChatTabId", "SplitChatTabId", "ActiveChatPane", "SessionKey", "BranchTree", "BranchActiveLeafId", "SystemPrompt", "SystemTools", "SystemInfoLoading", "SidebarOpen"]) {
      scope[`set${setter}`] = (value) => { result[setter] = value; };
    }
    scope.handleSelectSession = callback("handleSelectSession", scope);
    scope.handlePinSession = callback("handlePinSession", scope);
    boundAction(component, prop, scope)(session);

    assert.deepEqual(scope.chatTabsRef.current.map((tab) => tab.id), ["primary", "target"]);
    assert.equal(scope.chatTabsRef.current[1].preview, false);
    assert.equal(scope.chatTabsRef.current[1].pane, split ? "secondary" : "primary");
    assert.equal(result.ActiveChatTabId, split ? undefined : "target", "do not change the other group's selection");
    assert.equal(result.SplitChatTabId, split ? "target" : undefined);
    assert.equal(result.ActiveChatPane, split ? "secondary" : "primary");
    assert.equal(result.SelectedSession, session);
    assert.equal(result.SearchTarget, null);
    assert.equal(result.FileTabs.length, 0);
    assert.equal(result.ActiveFileTabId, null);
    assert.equal(result.RightPanelOpen, false);
    assert.equal(result.SidebarOpen, split ? undefined : false);
    assert.equal(result.metadata, "target");
    assert.equal(result.url, "?session=target");
  });
}
