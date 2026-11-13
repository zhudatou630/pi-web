import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
async function callback(path, name, scope) {
  const file = ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  return new Function("scope", `with(scope) { return ${ts.transpileModule(`(${find(file).getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText} }`)(scope);
}
const message = { role: "user", content: "try again" }, image = { data: "aW1n", mimeType: "image/png" };
for (const scenario of ["success", "image failure", "cancelled", "failed"]) test(`message fork draft: ${scenario}`, async () => {
  const events = [], media = Promise.withResolvers();
  const fork = await callback("./useAgentSession.ts", "handleFork", {
    bashRunningRef: { current: false }, sessionIdRef: { current: "source" }, setForkingEntryId() {}, console: { error() {} },
    sendAgentCommand: async (sid, cmd) => {
      assert.equal(sid, "source"); assert.deepEqual(cmd, { type: "fork", entryId: "entry", name: "Fork of source" });
      if (scenario === "failed") throw new Error("failed");
      return scenario === "cancelled" ? { cancelled: true } : { newSessionId: "copy" };
    },
    setDraft: (id, draft) => events.push(["draft", id, draft]), onSessionForked: (id) => events.push(["switch", id]),
  });
  let imageReads = 0;
  const click = await callback("../components/ChatWindow.tsx", "handleChatFork", {
    keepTabOpen() {}, sessionRef: { current: {} }, t: (v) => v, getForkSessionName: () => "Fork of source", handleFork: fork,
    getUserMessageText: (m) => { assert.equal(m, message); return "try again"; },
    getUserMessageDraftImages: (m) => { assert.equal(m, message); imageReads++; return media.promise; },
  });
  const pending = click("entry", message);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [], "must not switch before deferred images settle");
  if (scenario === "image failure") media.reject(new Error("missing image")); else media.resolve([image]);
  await pending;
  if (["cancelled", "failed"].includes(scenario)) { assert.deepEqual(events, []); assert.equal(imageReads, 0); }
  else assert.deepEqual(events, [["draft", "copy", { value: "try again", images: scenario === "image failure" ? [] : [image] }], ["switch", "copy"]]);
});
