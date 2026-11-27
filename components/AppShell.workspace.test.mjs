import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const helpers = await createJiti(import.meta.url).import("../lib/chat-view-state.ts");
const text = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
const start = text.indexOf("  useEffect(() => {\n    if (chatViewRestored ||");
const code = text.slice(start, text.indexOf("  const handleFocusPane =", start));
const script = new Script(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);

function shell(raw, { sessionId = null, requestedCwd = null } = {}) {
  const left = { id: "a", cwd: "/repo", name: "A" };
  const right = { id: "b", cwd: "/repo", name: "B" };
  const results = { stored: raw };
  const scope = {
    ...helpers, catalogLoaded: false, chatViewRestored: false,
    initialNavigation: { sessionId, requestedCwd, routines: null }, sessionCatalog: [left, right],
    window: { sessionStorage: {
      getItem: () => results.stored,
      setItem: (_key, value) => { results.stored = value; },
      removeItem: () => { results.stored = null; },
    } },
    chatViewRef: { current: helpers.EMPTY_CHAT_VIEW }, parked: [],
    rekeyDraft: (from, to) => scope.parked.push([from, to]), parkedNewSessionDraftKey: (cwd) => `parked-new:${cwd}`, chatSplitRatio: 0.5, keepMounted: () => false,
    commitChatView({ view }) { scope.chatViewRef.current = view; scope.chatView = view; },
    suppressCwdBumpRef: { current: false }, activeNewSessionDraftKeyRef: { current: null },
    useEffect: (fn) => fn(), router: { replace: (url) => { results.url = url; } },
  };
  scope.chatView = scope.chatViewRef.current;
  for (const name of ["ChatSplitRatio", "SelectedSession", "NewSessionCwd", "ChatViewRestored"]) scope[`set${name}`] = (value) => { results[name] = value; };
  return { scope, results, left, right, run: () => script.runInNewContext(scope) };
}

test("shell waits for the catalog before restoring both panes, and before saving", () => {
  const raw = JSON.stringify({ version: 1, primary: { kind: "session", id: "a" }, secondary: { kind: "session", id: "b" }, focusedPane: "secondary", splitRatio: 0.3 });
  const { scope, results, right, run } = shell(raw);
  run();
  assert.equal(results.ChatViewRestored, undefined);
  assert.equal(results.stored, raw, "the initial empty UI must not overwrite storage");
  scope.catalogLoaded = true;
  run();
  const view = scope.chatViewRef.current;
  assert.deepEqual([view.primaryId, view.secondaryId, view.focusedPane], ["a", "b", "secondary"]);
  assert.equal(results.SelectedSession, right);
  assert.equal(results.ChatSplitRatio, 0.3);
  assert.equal(results.url, "?session=b");
  assert.equal(results.ChatViewRestored, true);
  // Saving runs only once restored.
  scope.chatViewRestored = true;
  run();
  assert.equal(JSON.parse(results.stored).secondary.id, "b");
});

test("?session= focuses its pane without rewriting the URL; ?cwd= ignores the stored view", () => {
  const raw = JSON.stringify({ version: 1, primary: { kind: "session", id: "a" }, secondary: { kind: "session", id: "b" }, focusedPane: "secondary" });
  const linked = shell(raw, { sessionId: "a" });
  linked.scope.catalogLoaded = true;
  linked.run();
  assert.equal(linked.scope.chatViewRef.current.focusedPane, "primary");
  assert.equal(linked.results.url, undefined);
  const cwd = shell(raw, { requestedCwd: "/repo" });
  cwd.scope.catalogLoaded = true;
  cwd.run();
  assert.equal(cwd.scope.chatViewRef.current.primaryId, null);
  assert.equal(cwd.results.ChatViewRestored, true);
});

test("a link or ?cwd= that puts a stored draft off screen parks it; a stale link is replaced by what is shown", () => {
  const raw = JSON.stringify({ version: 1, primary: { kind: "draft", draftKey: "new:1:/repo", cwd: "/repo" }, secondary: null, focusedPane: "primary" });
  const linked = shell(raw, { sessionId: "a" });
  linked.scope.catalogLoaded = true;
  linked.run();
  assert.deepEqual(linked.scope.parked, [["new:1:/repo", "parked-new:/repo"]]);
  const cwd = shell(raw, { requestedCwd: "/repo" });
  cwd.scope.catalogLoaded = true;
  cwd.run();
  assert.deepEqual(cwd.scope.parked, [["new:1:/repo", "parked-new:/repo"]]);
  const kept = shell(raw);
  kept.scope.catalogLoaded = true;
  kept.run();
  assert.deepEqual(kept.scope.parked, []);
  // A deleted session in the link: the restored pane is named instead.
  const stale = shell(JSON.stringify({ version: 1, primary: { kind: "session", id: "a" }, secondary: null }), { sessionId: "gone" });
  stale.scope.catalogLoaded = true;
  stale.run();
  assert.equal(stale.results.url, "?session=a");
});
