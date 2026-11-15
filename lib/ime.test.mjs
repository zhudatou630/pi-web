import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";
const { isImeComposing } = await createJiti(import.meta.url).import("./ime.ts");

test("IME guards handle native, React and legacy keyboard events", () => {
  for (const event of [{ isComposing: true }, { keyCode: 229 }, { nativeEvent: { isComposing: true } }, { nativeEvent: {}, keyCode: 229 }]) {
    assert.equal(isImeComposing(event), true);
  }
  assert.equal(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } }), false);
});

test("extension dialog and custom-panel keyboard handlers ignore legacy IME confirmation", async () => {
  const source = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("ChatWindow.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const handlers = [];
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(file) === "onKeyDown") handlers.push(node.initializer.expression);
    ts.forEachChild(node, visit);
  }
  for (const node of file.statements) {
    if (ts.isFunctionDeclaration(node) && ["ExtensionDialog", "ExtensionCustomPanel"].includes(node.name?.text)) visit(node);
  }
  assert.equal(handlers.length, 6);
  for (const handler of handlers) {
    let actions = 0;
    const act = () => { actions++; };
    const bindings = { isImeComposing, composingRef: { current: false }, toTerminalKeyData: () => "\r", request: {},
      submitValue: act, onRespond: act, onInput: act };
    const code = ts.transpileModule(`return (${handler.getText(file)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const run = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
    for (const key of ["Enter", "Escape", "ArrowDown", " "]) {
      run({ key, ctrlKey: true, nativeEvent: { isComposing: false, keyCode: 229 }, preventDefault: act, stopPropagation: act });
    }
    assert.equal(actions, 0, handler.getText(file));
  }
});

test("plugin installation and skill search ignore composition and duplicate searches", async () => {
  const plugin = await readFile(new URL("../components/PluginsConfig.tsx", import.meta.url), "utf8");
  const skill = await readFile(new URL("../components/SkillsConfig.tsx", import.meta.url), "utf8");
  assert.match(plugin, /if \(isImeComposing\(e\)\) return;\s*if \(e.key === "Enter" && source.trim\(\) && !busy\)/);
  assert.match(skill, /if \(isImeComposing\(e\)\) return;\s*if \(e.key === "Enter" && !searching\)/);
  assert.match(skill, /if \(!q.trim\(\) \|\| searchInFlight.current\) return;/);
  assert.match(skill, /finally \{\s*searchInFlight.current = false;/);
});
