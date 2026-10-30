import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";
import ts from "typescript";

function parse(file) {
  return ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, child => find(child, predicate));
}
function script(text) {
  return new Script(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);
}

test("a new composer focus request runs once for its own draft and respects phones and dialogs", () => {
  const source = parse("./AppShell.tsx");
  const effect = find(source, node => ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]?.getText(source).includes("newComposerFocusKeyRef.current !== focusedDraftKey"));
  assert.ok(effect);
  for (const [mobile, coarse, modal, key, expected] of [
    [false, false, false, "new", 1], [true, false, false, "new", 0],
    [false, true, false, "new", 0], [false, false, true, "new", 0],
    [false, false, false, "other-pane", 0],
  ]) {
    let calls = 0;
    const frames = [];
    const context = {
      focusedDraftKey: key, newComposerFocusKeyRef: { current: "new" }, isMobile: mobile,
      window: { matchMedia: () => ({ matches: coarse }) },
      requestAnimationFrame: callback => { frames.push(callback); return 1; }, cancelAnimationFrame() {},
      isModalDialogOpen: () => modal, chatInputRef: { current: { focus: () => calls++ } },
    };
    const run = script(`(${effect.arguments[0].getText(source)})`).runInNewContext(context);
    run();
    frames.splice(0).forEach(f => f());
    run();
    frames.splice(0).forEach(f => f());
    assert.equal(calls, expected);
  }
  assert.equal((source.text.match(/newComposerFocusKeyRef.current = draftKey/g) ?? []).length, 2);
});

test("imperative composer focus puts the caret at the end of a restored draft", () => {
  const source = parse("./ChatInput.tsx");
  const focus = find(source, node => ts.isMethodDeclaration(node) && node.name.getText(source) === "focus");
  assert.ok(focus);
  const calls = [];
  const ta = { value: "restored draft 中文", focus: opts => calls.push(["focus", opts.preventScroll]), setSelectionRange: (a, b) => calls.push([a, b]) };
  script(`({${focus.getText(source)}}).focus()`).runInNewContext({ textareaRef: { current: ta } });
  assert.deepEqual(calls, [["focus", true], [ta.value.length, ta.value.length]]);
  script(`({${focus.getText(source)}}).focus()`).runInNewContext({ textareaRef: { current: null } });
});
