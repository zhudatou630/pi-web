import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const { toClientAgentEvent } = await createJiti(import.meta.url).import("../lib/agent-event-wire.ts");
const source = ts.createSourceFile("hook.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const clauses = [];
function visit(node) {
  if (ts.isCaseClause(node) && /^("(?:agent_start|agent_end|auto_retry_start|auto_retry_end|summarization_retry_.*|auto_compaction_end|compaction_end)")$/.test(node.expression.getText(source))) clauses.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
function setup() {
  let banner;
  const handle = vm.runInNewContext(ts.transpileModule(`(event) => { switch(event.type) { ${clauses.join("\n")} } }`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText, {
    setRetryInfo: (value) => { banner = value; }, setIsCompacting() {}, setCompactError() {}, setCompactResult() {}, readCompactResult() {},
    sessionIdRef: { current: null }, agentRunningRef: { current: true }, sdkAgentActiveRef: { current: true },
    promptRunIdRef: { current: 0 }, rpcPromptPendingRef: { current: false },
    cancelEventStreamGrace() {}, setAgentRunning() {}, setAgentPhase() {}, dispatch() {},
  });
  return { handle, banner: () => banner };
}
test("turn retries still show only during backoff, not during the retried response", () => {
  const h = setup();
  h.handle({ type: "agent_end", willRetry: true });
  h.handle({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" });
  assert.deepEqual({ ...h.banner() }, { attempt: 1, maxAttempts: 3, errorMessage: "overloaded" });
  h.handle({ type: "agent_start" });
  assert.equal(h.banner(), null);
  h.handle({ type: "auto_retry_end", success: true, attempt: 1 });
  assert.equal(h.banner(), null);
});

for (const end of ["summarization_retry_attempt_start", "summarization_retry_finished", "compaction_end", "auto_compaction_end"]) {
  test(`summarizer wait crosses the wire and clears on ${end}`, () => {
    const h = setup();
    const event = { type: "summarization_retry_scheduled", attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: "503 overloaded" };
    assert.deepEqual(toClientAgentEvent(event), event);
    h.handle(event);
    assert.deepEqual({ ...h.banner() }, { attempt: 2, maxAttempts: 3, errorMessage: "503 overloaded" });
    h.handle({ type: end });
    assert.equal(h.banner(), null);
  });
}
