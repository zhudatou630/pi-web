import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
const file = ts.createSourceFile("input.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let command, effect;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === "runBuiltinCommand") command = node.initializer.arguments[0];
  if (ts.isCallExpression(node) && node.expression.getText(file) === "useLayoutEffect" && node.arguments[1]?.getText(file) === "[builtinCommandPending]") effect = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(file);
const compile = (node, scope) => new Function("scope", `with(scope) { return ${ts.transpileModule(`(${node.getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText} }`)(scope);
function setup(focused = true) {
  const listeners = new Map(), body = {}, other = {};
  const document = { body, activeElement: body, querySelector: () => null, addEventListener: (k, fn) => listeners.set(k, fn), removeEventListener: (k) => listeners.delete(k) };
  let disabled = false, focuses = 0;
  const textarea = { isConnected: true, value: "/compact", selectionStart: 2, selectionEnd: 5, selectionDirection: "backward",
    focus: (options) => { assert.equal(disabled, false); assert.deepEqual(options, { preventScroll: true }); document.activeElement = textarea; focuses++; },
    setSelectionRange: (start, end, direction) => { textarea.selectionStart = start; textarea.selectionEnd = end; textarea.selectionDirection = direction; },
  };
  document.activeElement = focused ? textarea : other;
  const pending = Promise.withResolvers();
  const scope = { document, textareaRef: { current: textarea }, builtinCommandPending: false, builtinCommandPendingRef: { current: false }, builtinCommandFocusRef: { current: null },
    isEditing: false, attachedImages: [], quotes: [], attachedImagesRef: { current: [] }, valueRef: { current: "/compact" },
    canClearBuiltinCommandInput: () => false, clearInput() {}, onBuiltinCommand: () => pending.promise,
    setBuiltinCommandPending: (value) => { scope.builtinCommandPending = value; },
  };
  let cleanup;
  const commit = () => { cleanup?.(); disabled = scope.builtinCommandPending; if (disabled && document.activeElement === textarea) document.activeElement = body; cleanup = compile(effect, scope)(); };
  return { document, textarea, other, scope, commit, run: compile(command, scope), pending, listeners, focuses: () => focuses };
}
test("unlock restores focus and selection only after the enabling commit, including a failed command", async () => {
  const c = setup(); const request = c.run("/compact"); c.commit();
  c.textarea.selectionStart = c.textarea.selectionEnd = 0;
  c.pending.reject(new Error("failed")); await assert.rejects(request, /failed/);
  assert.equal(c.focuses(), 0); c.commit();
  assert.equal(c.document.activeElement, c.textarea);
  assert.deepEqual([c.textarea.selectionStart, c.textarea.selectionEnd, c.textarea.selectionDirection], [2, 5, "backward"]);
  c.document.activeElement = c.document.body; c.commit(); assert.equal(c.focuses(), 1);
});
for (const scenario of ["pointer", "tab", "focus moved", "modal", "unmounted", "not focused"]) test(`unlock does not steal focus: ${scenario}`, async () => {
  const c = setup(scenario !== "not focused"); const request = c.run("/compact"); c.commit();
  if (scenario === "pointer") c.listeners.get("pointerdown")({ target: c.document.body });
  if (scenario === "tab") c.listeners.get("keydown")({ key: "Tab" });
  if (scenario === "focus moved") { c.document.activeElement = c.other; c.listeners.get("focusin")({ target: c.other }); c.document.activeElement = c.document.body; }
  if (scenario === "modal") c.document.querySelector = () => ({});
  if (scenario === "unmounted") c.textarea.isConnected = false;
  c.pending.resolve({ handled: true }); await request; c.commit(); assert.equal(c.focuses(), 0);
});
