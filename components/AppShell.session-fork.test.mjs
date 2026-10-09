import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const { openSessionInNewTab, pinSessionTab, chatTabPane } = await createJiti(import.meta.url).import("../lib/chat-tab-state.ts");
const shellText = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("AppShell.tsx", shellText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "AppShell");
const names = ["handleSessionForked", "handleSidebarFork", "handleForkSession"];
const declarations = names.map((name) => {
  const declaration = component.body.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((node) => node.name.getText(source) === name);
  assert.ok(declaration?.initializer, `Missing callback: ${name}`);
  return `const ${declaration.getText(source)};`;
});
const callbacks = new Script(ts.transpileModule(`(() => { ${declarations.join("\n")} return { ${names.join(", ")} }; })()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText);

function setup(selectedId = "source") {
  const events = [];
  const session = { id: "source", name: "Plan", cwd: "/fixture" };
  const forked = { ...session, id: "copy", name: "Fork: Plan · abcd", parentSessionId: "source" };
  const chatTabsRef = { current: openSessionInNewTab([], session).tabs };
  let resolveFetch;
  const response = new Promise((resolve) => { resolveFetch = resolve; });
  const bindings = {
    useCallback: (callback) => callback,
    selectedSession: session, chatTabsRef, isSplitActiveRef: { current: false },
    activeSessionIdRef: { current: selectedId }, activeNewSessionDraftKeyRef: { current: null },
    forkInFlightRef: { current: false }, branchActiveLeafId: "viewed-leaf",
    openSessionInNewTab, pinSessionTab, chatTabPane,
    getForkSessionName: () => forked.name,
    translate: (key, params) => params?.error ?? (key === "session.forkNamePrefix" ? "Fork: " : key),
    setChatTabs: (update) => { chatTabsRef.current = update(chatTabsRef.current); },
    hydrateSelectedSession: (id) => events.push(["hydrate", id]),
    router: { replace: (url) => events.push(["navigate", url]) },
    fetch: () => { events.push(["request"]); return response; },
    sendAgentCommand: () => { events.push(["rpc"]); return response; },
    confirm: (message) => { events.push(["error", message]); },
  };
  for (const name of ["setRefreshKey", "setSessionKey", "setNewSessionCwd", "setSelectedSession", "setSplitChatTabId", "setActiveChatTabId", "setActiveChatPane", "setSessionForking", "setHistoryExportError", "setHistoryMenuOpen"]) {
    bindings[name] = (value) => events.push([name, value]);
  }
  return {
    events, bindings, forked,
    ...callbacks.runInNewContext(bindings),
    succeed: () => resolveFetch({ ok: true, json: async () => ({ sessionId: "copy", session: forked }) }),
    fail: () => resolveFetch({ ok: false, json: async () => ({ error: "Nothing to fork" }) }),
  };
}

test("sidebar fork prevents duplicate submissions and never steals focus after navigation", async () => {
  const s = setup();
  const pending = s.handleSidebarFork(s.bindings.selectedSession);
  await s.handleSidebarFork(s.bindings.selectedSession);
  await s.handleForkSession(); // Both menus share the submission guard.
  assert.equal(s.events.filter(([name]) => name === "request").length, 1);
  assert.equal(s.events.filter(([name]) => name === "rpc").length, 0);
  s.bindings.activeSessionIdRef.current = "other";
  s.succeed();
  await pending;
  assert.ok(s.events.some(([name]) => name === "setRefreshKey"));
  assert.equal(s.events.some(([name]) => name === "navigate" || name === "setSelectedSession"), false);
  assert.deepEqual(Array.from(s.bindings.chatTabsRef.current, (tab) => tab.id), ["source", "copy"]);
  assert.equal(s.bindings.forkInFlightRef.current, false);
});

test("forking an unselected sidebar row opens the named copy if the user stayed put", async () => {
  const s = setup("other");
  const pending = s.handleSidebarFork(s.bindings.selectedSession);
  s.succeed();
  await pending;
  assert.equal(s.events.find(([name]) => name === "setSelectedSession")[1].name, s.forked.name);
  assert.ok(s.events.some(([name, value]) => name === "navigate" && value === "?session=copy"));
  assert.equal(s.bindings.chatTabsRef.current[0].id, "source");
});

test("sidebar refusal is visible and releases the guard", async () => {
  const s = setup();
  const pending = s.handleSidebarFork(s.bindings.selectedSession);
  s.fail();
  await pending;
  assert.ok(s.events.some(([name, value]) => name === "error" && value === "Nothing to fork"));
  assert.equal(s.bindings.forkInFlightRef.current, false);
  assert.equal(s.bindings.chatTabsRef.current.length, 1);
});

test("row Fork follows Rename, precedes read status, and has no running guard", () => {
  const sidebar = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  const item = sidebar.slice(sidebar.indexOf("export function SessionItem"));
  const fork = item.indexOf('t("sidebar.fork")');
  assert.ok(fork > item.indexOf('t("sidebar.rename")'));
  assert.ok(fork < item.indexOf('"sidebar.markRead"'));
  const button = item.slice(item.lastIndexOf("<button", fork), fork);
  assert.match(button, /disabled=\{forking/);
  assert.doesNotMatch(button, /isRunning/);
  assert.match(shellText, /forkDisabled=\{!session \|\| Boolean\(session.transient\)\}/);
});
