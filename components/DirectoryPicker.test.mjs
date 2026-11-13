import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("DirectoryPicker.tsx", readFileSync(new URL("./DirectoryPicker.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name, context) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (ts.isCallExpression(found)) found = found.arguments[0];
  return new Script(ts.transpileModule(`(${found.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext(context);
}
function inputChange(context) {
  let found;
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "input") {
      found = node.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "onChange").initializer.expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return new Script(ts.transpileModule(`(${found.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext(context);
}
function fixture(loadDirectories) {
  const state = {};
  const context = { Error, loadDirectories, navigationRef: { current: 0 }, onCancel() {}, onSelect: (path) => { state.selected = path; }, canSelect: true, hasUncommittedPath: true, typedPath: "/alias/../link/", currentPath: "/old" };
  for (const key of ["Loading", "LoadError", "CurrentPath", "ParentDirectory", "PathInput", "Directories", "Drives"]) context[`set${key}`] = (value) => { state[key] = value; };
  context.navigateTo = callback("navigateTo", context);
  return { state, context, select: callback("handleSelect", context), cancel: callback("cancel", context), editPath: inputChange(context) };
}
test("Select browses typed input and chooses the canonical folder", async () => {
  const f = fixture(async (input) => { assert.equal(input, "/alias/../link/"); return { path: "/real" }; });
  await f.select();
  assert.equal(f.state.selected, "/real");
  assert.equal(f.state.PathInput, "/real");
});
test("refused, superseded and cancelled Select never select a stale folder", async () => {
  const bad = fixture(async () => { throw new Error("missing"); });
  await bad.select();
  assert.equal(bad.state.LoadError, "missing");
  assert.equal(bad.state.selected, undefined);
  for (const supersede of [false, true]) {
    let release;
    const f = fixture(() => new Promise((resolve) => { release = resolve; }));
    const selected = f.select();
    if (supersede) f.context.navigationRef.current += 1;
    else f.cancel();
    release({ path: "/late" });
    await selected;
    assert.equal(f.state.selected, undefined);
    assert.equal(f.state.CurrentPath, undefined);
  }
});

for (const refusal of [false, true]) {
  test(`editing the bound path input cancels a pending Select (${refusal ? "late error" : "late success"})`, async () => {
    let resolve, reject;
    const f = fixture(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const selecting = f.select();
    assert.equal(f.state.Loading, true);
    f.editPath({ target: { value: "/new-choice" } });
    assert.equal(f.state.Loading, false, "editing must make the new path selectable without waiting");
    if (refusal) reject(new Error("old path failed")); else resolve({ path: "/old-choice-realpath" });
    await selecting;
    assert.equal(f.state.selected, undefined);
    assert.equal(f.state.PathInput, "/new-choice");
    assert.equal(f.state.LoadError, null);
    f.context.typedPath = f.state.PathInput;
    const fresh = f.select();
    resolve({ path: "/new-choice-realpath" });
    await fresh;
    assert.equal(f.state.selected, "/new-choice-realpath");
  });
}
