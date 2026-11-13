import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { mergeLoadedHistory } = await jiti.import("../lib/chat-history-merge.ts");
const { isHiddenCustomMessage } = await jiti.import("../lib/message-display.ts");
const file = ts.createSourceFile("hook.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function find(root, predicate) { if (predicate(root)) return root; return ts.forEachChild(root, (child) => find(child, predicate)); }
const js = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function callback(name, scope) {
  const node = find(file, (n) => ts.isVariableDeclaration(n) && n.name.getText(file) === name);
  return new Function("scope", `with(scope) { ${js(`return (${node.initializer.arguments[0].getText(file)});`)} }`)(scope);
}
const clause = find(file, (n) => ts.isCaseClause(n) && n.expression.getText(file) === '"message_end"');
const eventHandler = new Function("scope", `with(scope) { ${js(`return (event) => { switch(event.type) { ${clause.getText(file)} } };`)} }`);
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const ref = (current) => ({ current });
const custom = (text, display = true) => ({ role: "custom", customType: "watcher", content: text, display, timestamp: text.length });
function fixture() {
  const server = { messages: [custom("one"), custom("two"), custom("three")], entryIds: ["1", "2", "3"], hold: false, held: [], reads: 0 };
  const previous = { messages: server.messages.slice(), entryIds: server.entryIds.slice(), oldestEntryId: "1", hasMore: true };
  const writes = { history: previous };
  const scope = {
    sessionHookMountedRef: ref(true), endedSessionRef: ref(null), navigationPendingRef: ref(false), historyBranchRef: ref(0), sessionIdRef: ref("s"),
    promptRunIdRef: ref(0), contextUsageRequestIdRef: ref(0), localAppendSeqRef: ref(0), loadedHistoryRef: ref(previous),
    agentRunningRef: ref(false), bashRunningRef: ref(false), modelSwitchPendingRef: ref(false), modelSelectionVersionRef: ref(0), sessionToolsPinnedRef: ref(false),
    idleMessageReadRef: ref({ sid: "", dirty: false, reading: false }), mergeLoadedHistory, isHiddenCustomMessage,
    setLoading() {}, setError() {}, setMessageKeyAliases() {},
    setData(value) { writes.data = typeof value === "function" ? value(writes.data) : value; },
    setActiveLeafId(value) { writes.leaf = value; }, setMessages(value) { writes.messages = value; }, setEntryIds(value) { writes.ids = value; },
    setHistoryCursor() {}, setHasEarlierMessages() {}, setToolPresetState() {}, setCurrentModelOverride() {}, applyContextUsage() {},
    CONFIGURED_TOOL_PRESET: "configured", carryMessageKeys: () => new Map(),
    async fetch(url) {
      server.reads++;
      const anchor = new URL(url, "http://test").searchParams.get("anchor");
      const at = anchor ? server.entryIds.indexOf(anchor) : -1;
      const start = at >= 0 ? at : Math.max(0, server.entryIds.length - 2);
      const context = { messages: server.messages.slice(start), entryIds: server.entryIds.slice(start), oldestEntryId: server.entryIds[start], hasMore: true };
      const response = { ok: true, json: async () => ({ context, sessionId: "s", leafId: server.entryIds.at(-1), tree: [] }) };
      if (server.hold) { const gate = Promise.withResolvers(); server.held.push(gate); await gate.promise; }
      return response;
    },
  };
  scope.loadSession = callback("loadSession", scope);
  scope.refreshIdleMessages = callback("refreshIdleMessages", scope);
  const event = eventHandler(scope);
  const post = (id, message) => { server.entryIds.push(id); server.messages.push(message); event({ type: "message_end", message }); };
  return { scope, server, writes, post };
}
test("visible idle custom messages merge real ids/leaf without dropping loaded pages or duplicating events", async () => {
  const f = fixture();
  f.post("4", custom("four")); await tick();
  assert.deepEqual(f.writes.ids, ["1", "2", "3", "4"]);
  assert.equal(f.writes.leaf, "4");
  assert.equal(f.writes.messages.length, 4);
  await f.scope.refreshIdleMessages("s");
  assert.equal(f.writes.messages.length, 4);
  const reads = f.server.reads;
  f.post("5", custom("hidden", false)); await tick();
  assert.equal(f.server.reads, reads);
  f.post("6", custom("truthy", 1)); await tick();
  assert.equal(f.writes.ids.at(-1), "6");
});
test("an older forced snapshot is fenced; a burst during the idle read shares exactly one follow-up", async () => {
  const f = fixture(); f.server.hold = true;
  const stale = f.scope.loadSession("s", true);
  f.post("4", custom("four")); await tick();
  f.post("5", custom("five")); f.post("6", custom("six"));
  assert.equal(f.server.reads, 2);
  f.server.held.shift().resolve(); await stale;
  assert.equal(f.writes.messages, undefined, "pre-event snapshot did not apply");
  f.server.hold = false;
  f.server.held.shift().resolve(); await tick();
  assert.equal(f.server.reads, 3);
  assert.deepEqual(f.writes.ids, ["1", "2", "3", "4", "5", "6"]);
});
for (const boundary of ["run", "branch", "session", "unmount"]) {
  test(`idle read does not land across ${boundary}`, async () => {
    const f = fixture(); f.server.hold = true;
    f.post("4", custom("four")); await tick();
    if (boundary === "run") { f.scope.agentRunningRef.current = true; f.scope.promptRunIdRef.current++; }
    if (boundary === "branch") f.scope.historyBranchRef.current++;
    if (boundary === "session") f.scope.sessionIdRef.current = "other";
    if (boundary === "unmount") f.scope.sessionHookMountedRef.current = false;
    f.server.held.shift().resolve(); await tick();
    assert.equal(f.writes.messages, undefined);
  });
}
test("the real session route extends its tail to the loaded anchor, but not across a branch", async () => {
  const source = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const start = source.indexOf("    let tail =");
  const end = source.indexOf("    const context", start);
  const branch = Array.from({ length: 2500 }, (_, i) => ({ id: String(i) }));
  const run = new Function("rawTail", "searchParams", "sm", "leafId", `${js(source.slice(start, end))}; return tail;`);
  const sm = { getBranch: (leaf) => { assert.equal(leaf, "live-leaf"); return branch; } };
  assert.equal(run(200, new URLSearchParams({ anchor: "100" }), sm, "live-leaf"), 2400);
  assert.equal(run(200, new URLSearchParams({ anchor: "other-branch" }), sm, "live-leaf"), 200);
});

test("bash and navigation defer idle refresh instead of exposing a duplicate pending command", async () => {
  const f = fixture(); f.scope.bashRunningRef.current = true;
  f.post("4", custom("four")); await tick(); assert.equal(f.server.reads, 0);
  f.scope.bashRunningRef.current = false; f.scope.navigationPendingRef.current = true;
  await f.scope.refreshIdleMessages("s"); assert.equal(f.server.reads, 0);
  f.scope.navigationPendingRef.current = false;
  await f.scope.refreshIdleMessages("s");
  assert.equal(f.writes.ids.at(-1), "4");
});
