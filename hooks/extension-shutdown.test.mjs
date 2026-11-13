import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
function find(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === "handleAgentEvent") return node.initializer.arguments[0];
  return ts.forEachChild(node, find);
}
const js = ts.transpileModule(`return (${find(file).getText(file)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const ref = (current) => ({ current });
function pane(sid) {
  const calls = [];
  const scope = {
    sessionIdRef: ref(sid), endedSessionRef: ref(null), localAppendSeqRef: ref(0), promptRunIdRef: ref(0),
    historyBranchRef: ref(0), navigationPendingRef: ref(false), idleMessageReadRef: ref({ dirty: false }),
    loadSession: () => calls.push("final-history-read"),
    rpcPromptPendingRef: ref(true), sdkAgentActiveRef: ref(true), bashRunningRef: ref(false),
    eventConnectionRef: ref({ close: () => calls.push("close") }),
    setLoading() {}, setError() {},
    setSessionEnded: (value) => calls.push(["ended", value]), cancelEventStreamGrace: () => calls.push("cancelGrace"),
    settleUiStage: () => calls.push("settle"), setBashRunning() {}, setPendingBash() {}, setIsCompacting() {},
    setQueuedMessages() {}, setExtensionDialogs() {}, setExtensionCustomUis() {},
    flushStreamDeltas() {}, unconfirmedPromptsRef: ref(new Map()),
  };
  return { scope, calls, event: new Function("scope", `with(scope) { ${js} }`)(scope) };
}
test("explicit exit marks only its pane read-only, cancels reconnect/grace, and ignores late events", () => {
  const left = pane("left"), right = pane("right");
  const ended = { type: "session_ended", sessionId: "left" };
  right.event(ended); assert.deepEqual(right.calls, []);
  left.event(ended);
  assert.equal(left.scope.endedSessionRef.current, "left");
  assert.ok(left.calls.some((call) => Array.isArray(call) && call[0] === "ended" && call[1]));
  assert.ok(left.calls.includes("close"));
  assert.ok(left.calls.includes("final-history-read"));
  const count = left.calls.length;
  left.event(ended); left.event({ type: "connected", isStreaming: true }); left.event({ type: "agent_start" });
  assert.equal(left.calls.length, count);
  assert.equal(right.scope.endedSessionRef.current, null);
});
test("ended state uses the existing notice shelf and disables the composer without discarding tabs", async () => {
  const view = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(view, /disabled=\{isQueuedSubagent \|\| sessionEnded\}/);
  assert.match(view, /NoticeShelf notices=\{sessionEnded/);
  assert.match(view, /t\("chat.sessionEnded"\)/);
});
