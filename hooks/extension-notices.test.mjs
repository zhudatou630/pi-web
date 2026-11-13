import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
function find(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === "addNotice") return node.initializer.arguments[0];
  return ts.forEachChild(node, find);
}
const callback = ts.transpileModule(`(${find(file).getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.replace(/;\s*$/, "");
function pane() {
  const shownNoticeIdsRef = { current: new Set() };
  const notices = [];
  return { notices, add: new Function("shownNoticeIdsRef", "dispatchNotice", `return ${callback}`)(shownNoticeIdsRef, (action) => notices.push(action.notice)) };
}
test("notice replay deduplication is pane-local and bounded, not shared between split panes", () => {
  const left = pane(), right = pane();
  const notice = { id: "startup", message: "broken extension", type: "error" };
  for (const p of [left, right]) { p.add(notice); p.add(notice); assert.equal(p.notices.length, 1); }
  for (let i = 0; i < 200; i++) left.add({ ...notice, id: String(i) });
  left.add(notice);
  assert.equal(left.notices.length, 202);
  right.add(notice);
  assert.equal(right.notices.length, 1);
});
