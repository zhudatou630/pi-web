import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const helpers = await createJiti(import.meta.url).import("../lib/chat-workspace-state.ts");
const text = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
const start = text.indexOf("  useEffect(() => {\n    if (chatWorkspaceRestored ||");
const code = text.slice(start, text.indexOf("  const handleFocusPane =", start));
const script = new Script(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);

test("shell waits for successful catalog load before restoring and before saving", () => {
  const selected = { id: "a", cwd: "/repo", name: "A" };
  let raw = JSON.stringify({ version: 1, tabs: [{ kind: "session", id: "a" }], activeId: "a" });
  const results = {};
  const scope = { ...helpers, Set, catalogLoaded: false, draftTabsRestored: true, chatWorkspaceRestored: false,
    initialNavigation: { sessionId: null, requestedCwd: null, routines: null }, sessionCatalog: [selected],
    window: { sessionStorage: { getItem: () => raw, setItem: (_key, value) => { raw = value; } } },
    chatTabs: [], chatTabsRef: { current: [] }, activeChatTabId: null, splitChatTabId: null, activeChatPane: "primary", chatSplitRatio: 0.5,
    suppressCwdBumpRef: { current: false }, activeNewSessionDraftKeyRef: { current: null },
    useEffect: (fn) => fn(), router: { replace: (url) => { results.url = url; } },
  };
  for (const name of ["ChatTabs", "ActiveChatTabId", "SplitChatTabId", "ActiveChatPane", "ChatSplitRatio", "SelectedSession", "NewSessionCwd", "ChatWorkspaceRestored"]) scope[`set${name}`] = (value) => { results[name] = value; };
  script.runInNewContext(scope);
  assert.equal(results.ChatTabs, undefined);
  assert.equal(JSON.parse(raw).tabs.length, 1, "the initial empty UI must not overwrite storage");
  scope.catalogLoaded = true;
  script.runInNewContext(scope);
  assert.equal(results.SelectedSession, selected);
  assert.equal(results.ActiveChatTabId, "a");
  assert.equal(results.url, "?session=a");
  assert.equal(results.ChatWorkspaceRestored, true);
});
