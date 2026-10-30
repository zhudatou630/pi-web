import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const { recalledQueuedPrompts } = await createJiti(import.meta.url).import("../lib/queued-messages.ts");
const file = ts.createSourceFile("hook.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function find(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (child) => find(child, predicate));
}
function callback(name, bindings) {
  const node = find(file, (n) => ts.isVariableDeclaration(n) && n.name.getText(file) === name);
  assert.ok(node, name);
  const js = ts.transpileModule(`return (${node.initializer.arguments[0].getText(file)});`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
const noop = () => {};
function setup() {
  const calls = [], notices = [], restored = [], timers = [];
  const request = Promise.withResolvers();
  let compacting = false;
  const bindings = {
    sessionIdRef: { current: "scratch" }, isCompacting: false,
    setIsCompacting: (value) => { compacting = value; },
    setCompactError: (value) => calls.push(["error", value]), setCompactResult: noop,
    sendAgentCommand: async (_sid, command) => { calls.push(command); return request.promise; },
    loadSession: async () => calls.push("reload"), promoteNewSession: () => calls.push("promote"),
    readCompactResult: (value) => value, composerDraftKey: "sending-draft",
    restoreSubmission: (...args) => restored.push(args), addNotice: (notice) => notices.push(notice),
    setTimeout: (fn) => timers.push(fn),
  };
  bindings.handleCompact = callback("handleCompact", bindings);
  return { bindings, request, calls, notices, restored, timers, compacting: () => compacting };
}

test("/compact detaches the whole request, leaving the composer and Stop usable", async () => {
  const h = setup();
  const command = callback("handleBuiltinSlashCommand", h.bindings);
  const result = await Promise.race([command("/compact keep decisions"), new Promise((_, reject) => setTimeout(() => reject(new Error("blocked by compaction POST")), 100))]);
  assert.deepEqual(result, { handled: true, action: "compact" });
  assert.equal(h.compacting(), true);
  assert.deepEqual(h.calls.find((call) => call?.type === "compact"), { type: "compact", customInstructions: "keep decisions" });
  assert.deepEqual(h.notices, [], "the compact result banner owns feedback, not a premature success notice");
  h.request.resolve({ tokensBefore: 10 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.compacting(), false);
  assert.ok(h.calls.includes("reload"));
  assert.ok(h.calls.includes("promote"));
});

test("detached compact failure restores the original command after its caller clears input", async () => {
  const h = setup();
  const compact = h.bindings.handleCompact({ customInstructions: "keep decisions", restoreCommand: "/compact keep decisions" });
  h.request.reject(new Error("summary failed")); await compact;
  assert.deepEqual(h.restored, []);
  for (const fn of h.timers) fn();
  assert.deepEqual(h.restored, [["/compact keep decisions", undefined, "sending-draft"]]);
  assert.equal(h.compacting(), false);
});

test("Recall and Stop share text/image restoration into the originating draft", () => {
  const h = setup();
  const restore = callback("restoreRecalledQueue", { ...h.bindings, recalledQueuedPrompts });
  const image = { data: "aW1hZ2U=", mimeType: "image/png" };
  restore({ steering: [{ text: "first", images: [image] }], followUp: [{ text: "second", images: [] }] });
  assert.deepEqual(h.restored, [["first\n\nsecond", [{ ...image, previewUrl: "" }], "sending-draft"]]);
});
