import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("ChatInput.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const methods = {};
function visit(node) {
  if (ts.isMethodDeclaration(node) && ["setText", "pasteText"].includes(node.name.getText(file))) {
    const name = node.name.getText(file);
    methods[name] = ts.transpileModule(`function ${node.getText(file)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  }
  ts.forEachChild(node, visit);
}
visit(file);
function fixture(value = "old draft", withTextarea = true) {
  const edits = [];
  const textarea = { value, selectionStart: 2, selectionEnd: 5 };
  const scope = {
    textareaRef: { current: withTextarea ? textarea : null }, valueRef: { current: value },
    setValue(next) { scope.value = next; }, setCursorPosition() {}, setAtQuery() {},
    replaceTextareaRange(ta, start, end, text) {
      edits.push({ start, end, text });
      ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + text.length;
    },
  };
  return { scope, textarea, edits, ...Object.fromEntries(Object.entries(methods).map(([name, js]) => [name, new Function("scope", `with (scope) { ${js}; return ${name}; }`)(scope)])) };
}

test("extension replacement replaces all text in one native edit, including empty and long drafts", () => {
  const f = fixture("x".repeat(100000));
  f.setText("first");
  f.setText("last");
  f.setText("");
  assert.deepEqual(f.edits, [{ start: 0, end: 100000, text: "first" }, { start: 0, end: 5, text: "last" }, { start: 0, end: 4, text: "" }]);
  assert.equal(f.scope.value, "");
  assert.equal(f.scope.valueRef.current, "");
});

test("paste inserts verbatim at selection and empty paste leaves the selection alone", () => {
  const f = fixture("abcdef");
  f.pasteText("");
  assert.equal(f.edits.length, 0);
  assert.equal(f.textarea.selectionEnd, 5);
  f.pasteText("ONE");
  f.pasteText("TWO");
  assert.equal(f.scope.value, "abONETWOf");
});

test("editor calls before textarea mounting retain the last text and exact paste", () => {
  const f = fixture("old", false);
  f.setText("new");
  f.pasteText("!");
  assert.equal(f.scope.value, "new!");
});
