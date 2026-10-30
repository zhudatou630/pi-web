import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

const compiled = ts.transpileModule(readFileSync(new URL("./ModelSelector.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Small hook host: run the real component and its event handlers without a DOM dependency.
function picker(props) {
  const slots = [];
  let cursor = 0;
  const slot = (init) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = init();
    return index;
  };
  const hooks = {
    ...React,
    useRef: (value) => slots[slot(() => ({ current: value }))],
    useState: (value) => {
      const index = slot(() => typeof value === "function" ? value() : value);
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useId: () => "picker",
    useEffect() {}, useMemo: (fn) => fn(), useCallback: (fn) => fn,
  };
  const loaded = { exports: {} };
  new Function("require", "module", "exports", "window", compiled)(
    (name) => name === "react" ? hooks : name === "./MenuCheck" ? { MenuCheck: () => null } : jsxRuntime, loaded, loaded.exports,
    { innerHeight: 800, innerWidth: 1200 },
  );
  let tree;
  function visit(node, predicate, output = []) {
    if (Array.isArray(node)) { node.forEach((child) => visit(child, predicate, output)); return output; }
    if (!React.isValidElement(node)) return output;
    if (typeof node.type === "function") return visit(node.type(node.props), predicate, output);
    if (predicate(node)) output.push(node);
    visit(node.props.children, predicate, output);
    return output;
  }
  const render = () => {
    cursor = 0;
    tree = loaded.exports.ModelSelector(props);
    button().props.ref.current = { getBoundingClientRect: () => ({ top: 600, bottom: 634, left: 10, right: 210, width: 200 }) };
  };
  const button = () => visit(tree, (node) => node.props.role === "combobox")[0];
  render();
  return {
    key: (key) => { button().props.onKeyDown({ key, preventDefault() {} }); render(); },
    options: () => visit(tree, (node) => node.props.role === "option"),
    groups: () => visit(tree, (node) => node.props.className === "menu-surface-group"),
    active: () => {
      const id = button().props["aria-activedescendant"];
      return visit(tree, (node) => node.props.id === id && node.props.role === "option")[0];
    },
    html: () => renderToStaticMarkup(tree),
  };
}

for (const clear of [false, true]) {
  test(`interleaved providers sort by provider then name; display and keyboard order agree with ArrowDown, Home and End (clear=${clear})`, () => {
    const options = [
      { provider: "b", modelId: "b1", name: "B1" },
      { provider: "a", modelId: "a3", name: "A3" },
      { provider: "a", modelId: "a1", name: "A1" },
      { provider: "a", modelId: "a2", name: "A2" },
    ];
    const chosen = [];
    const state = picker({ options, value: options[2], onChange: (...args) => chosen.push(args), ...(clear ? { onClear() {}, emptyLabel: "Default" } : {}) });
    state.key("ArrowDown"); // Open at A1.
    const labels = state.options().map((option) => option.props.children[0].props.children);
    assert.deepEqual(labels, [...(clear ? ["Default"] : []), "A1", "A2", "A3", "B1"]);
    assert.equal(state.active().props.children[0].props.children, "A1");
    const keys = state.groups().map((group) => group.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(state.groups().length, 2); // One header per provider.
    const html = state.html();
    assert.ok(html.indexOf('title="A1"') < html.indexOf('title="A2"'));
    assert.ok(html.indexOf('title="A3"') < html.indexOf('title="B1"'));
    state.key("ArrowDown");
    assert.equal(state.active().props.children[0].props.children, "A2");
    state.key("End");
    assert.equal(state.active().props.children[0].props.children, "B1");
    state.key("Home");
    assert.equal(state.active().props.children[0].props.children, clear ? "Default" : "A1");
    if (clear) state.key("ArrowDown");
    state.key("ArrowDown");
    state.key("Enter");
    assert.deepEqual(chosen, [["a", "a2"]]);
    assert.deepEqual(options.map((option) => option.modelId), ["b1", "a3", "a1", "a2"]); // Input not mutated.
  });
}
