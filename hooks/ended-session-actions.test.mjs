import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const { AgentCommandError } = await createJiti(import.meta.url).import("../lib/agent-client.ts");
const file = ts.createSourceFile("hook.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function callback(name, scope, sourceFile = file) {
  const find = (node) => ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === name ? node.initializer.arguments[0] : ts.forEachChild(node, find);
  const js = ts.transpileModule(`return (${find(sourceFile).getText(sourceFile)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("scope", `with(scope) { ${js} }`)(scope);
}
const ref = (current) => ({ current });
function pane() {
  const posts = [], selections = [];
  const scope = {
    endedSessionRef: ref(null), sessionIdRef: ref("saved"), AgentCommandError, t: (key) => key,
    postAgentCommand: async (sid, command) => { posts.push([sid, command]); return {}; },
    isCompacting: false, setIsCompacting() {}, setCompactError() {}, setCompactResult() {},
    readCompactResult() {}, promoteNewSession() {}, loadSession() {},
    isNew: false, setThinkingLevel: (value) => selections.push(value),
    setPreferredToolPreset: (value) => selections.push(value), getToolNamesForPreset: () => ["read"],
    setToolPresetState: (value) => selections.push(value),
    bashRunningRef: ref(false), agentRunningRef: ref(false), sessionRunningRef: ref(false),
    navigationPendingRef: ref(false), historyBranchRef: ref(0),
    console: { error() {} },
  };
  scope.sendAgentCommand = callback("sendAgentCommand", scope);
  return { scope, posts, selections, run: (name, ...args) => callback(name, scope)(...args) };
}
test("a stale ended-pane action cannot send any agent RPC, while another/reopened view can", async () => {
  const ended = pane(), other = pane();
  ended.scope.endedSessionRef.current = "saved";
  for (const type of ["set_model", "set_thinking_level", "set_tools", "compact", "navigate_tree", "prompt", "reload", "fork", "fork_branch", "get_state"]) {
    await assert.rejects(ended.scope.sendAgentCommand("saved", { type }), { status: 409 });
  }
  assert.deepEqual(ended.posts, []);
  await other.scope.sendAgentCommand("saved", { type: "set_model" });
  assert.equal(other.posts.length, 1);
  const reopened = pane();
  await reopened.scope.sendAgentCommand("saved", { type: "prompt" });
  assert.equal(reopened.posts.length, 1, "there is no session-id-wide ban");
});
test("pane-header RPCs cannot bypass the ended-view gate, which resets when the view is reopened", async () => {
  const shell = ts.createSourceFile("shell.tsx", await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const posts = [];
  const cache = new Map([["saved", { onLeafChange: undefined }]]);
  const send = callback("sendAgentCommand", { branchDataCacheRef: ref(cache), translate: (key) => key, postAgentCommand: async (...args) => posts.push(args) }, shell);
  for (const type of ["fork_branch", "set_cache_keepalive"]) await assert.rejects(send("saved", { type }), /chat.sessionEnded/);
  assert.deepEqual(posts, []);
  cache.set("saved", { onLeafChange() {} });
  await send("saved", { type: "fork_branch" });
  assert.equal(posts.length, 1);
});

test("actual compact/model/thinking/tools/navigation handlers are inert after shutdown", async () => {
  const p = pane(); p.scope.endedSessionRef.current = "saved";
  await p.run("handleCompact");
  await p.run("handleModelChange", "provider", "model");
  await p.run("handleThinkingLevelChange", "high");
  await p.run("handleToolPresetChange", "full");
  assert.equal(await p.run("handleLeafChange", "old-branch"), false);
  assert.deepEqual(p.posts, []);
  assert.deepEqual(p.selections, [], "read-only controls cannot change optimistic or persisted preferences");
});
