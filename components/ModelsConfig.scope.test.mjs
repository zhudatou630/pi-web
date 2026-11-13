import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const { allPatternsUnmatched, isExactList, modelPickerRef, removePattern, removeVisibleModel } = await createJiti(import.meta.url).import("../lib/model-picker.ts");
const source = ts.createSourceFile("ModelsConfig.tsx", readFileSync(new URL("./ModelsConfig.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ["saveScope", "removeFromChat"].includes(node.name.getText(source))) {
    callbacks.set(node.name.getText(source), node.initializer.arguments[0].getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
const compiled = ts.transpileModule([...callbacks].map(([name, fn]) => `const ${name} = ${fn};`).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function panel(document) {
  const writes = [];
  const errors = [];
  const dependencies = {
    allPatternsUnmatched, isExactList, modelPickerRef, removeVisibleModel,
    cwd: "/fixture", scopeDoc: document, scopeWriteRef: { current: Promise.resolve() },
    fetchScopeDocument: async () => document,
    t: key => key,
    setScopeError: value => errors.push(value),
    setScopeSaving() {}, setScopeNotice() {}, setScopeDoc() {}, onModelsChanged() {},
    fetch: async (_url, request) => { writes.push(JSON.parse(request.body)); return Response.json(document); },
  };
  const actions = new Function(...Object.keys(dependencies), `${compiled}; return { saveScope, removeFromChat };`)(...Object.values(dependencies));
  return { ...actions, writes, errors };
}

const singleModel = { source: "none", patterns: [], readOnly: false, visible: [{ provider: "p", id: "one" }], matches: {}, pins: {}, defined: ["p/one"] };

test("switching off the only model without enabledModels reports the keep-one warning and writes nothing", async () => {
  const state = panel(singleModel);
  await state.removeFromChat("p/one");
  assert.deepEqual(state.errors, ["models.keepOneModel"]);
  assert.deepEqual(state.writes, []);
});

test("an existing wholly unmatched rule still permits explicit removal", async () => {
  const state = panel({ ...singleModel, source: "global", patterns: ["gone/**"], matches: { "gone/**": [] } });
  assert.equal(await state.saveScope(current => removePattern(current.patterns, "gone/**")), true);
  assert.deepEqual(state.writes, [{ cwd: "/fixture", patterns: [] }]);
});
