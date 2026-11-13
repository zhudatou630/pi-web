import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createJiti } from "jiti";

const providerListing = await createJiti(import.meta.url).import("../../lib/provider-listing.ts");
const compiled = ts.transpileModule(readFileSync(new URL("./AuthDetail.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function authDetail(fetch) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let dirty = false;
  let tree;
  let props;
  const slot = init => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = init();
    return index;
  };
  const hooks = {
    ...React,
    useState(initial) {
      const index = slot(() => typeof initial === "function" ? initial() : initial);
      return [slots[index], update => {
        const next = typeof update === "function" ? update(slots[index]) : update;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useCallback: fn => fn,
    useEffect(run, deps) {
      const state = slots[slot(() => ({}))];
      if (!state.deps || deps.some((value, index) => value !== state.deps[index])) effects.push(() => {
        state.cleanup?.();
        state.deps = deps;
        state.cleanup = run();
      });
    },
  };
  const loaded = { exports: {} };
  new Function("require", "module", "exports", "fetch", "setTimeout", compiled)(name => {
    if (name === "react") return hooks;
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "@/lib/provider-listing") return providerListing;
    if (name === "@/hooks/useI18n") return { useI18n: () => ({ t: key => key }) };
    if (name === "@/hooks/useConfirm") return { useConfirm: () => async () => true };
    if (name === "../SettingsUi") return { ConfigButton: p => React.createElement("button", p), ConfigField: p => React.createElement("label", p) };
    if (name === "./fields") return {
      Notice: p => React.createElement("p", { role: "alert" }, p.children),
      TextInput: p => React.createElement("input", { ...p, type: "url" }),
      SecretTextInput: p => React.createElement("input", { ...p, type: "password" }),
    };
    throw new Error(`Unexpected import: ${name}`);
  }, loaded, loaded.exports, fetch, () => 0);
  const render = () => {
    do {
      dirty = false;
      cursor = 0;
      effects = [];
      tree = loaded.exports.ApiKeyDetail(props);
      effects.forEach(run => run());
    } while (dirty);
  };
  function nodes(node, output = []) {
    if (Array.isArray(node)) { node.forEach(child => nodes(child, output)); return output; }
    if (!React.isValidElement(node)) return output;
    if (typeof node.type === "function") return nodes(node.type(node.props), output);
    output.push(node);
    nodes(node.props.children, output);
    return output;
  }
  const setProvider = provider => { props = { provider, cwd: null, onRefresh() { setProvider({ ...provider, configured: true }); } }; render(); };
  return {
    setProvider,
    save: async () => { await nodes(tree).find(node => node.type === "button" && node.props.variant === "primary").props.onClick(); render(); },
    alerts: () => nodes(tree).filter(node => node.props.role === "alert").map(node => node.props.children),
    routerUrl: () => nodes(tree).find(node => node.type === "input" && node.props.type === "url")?.props.value,
  };
}

test("the first llama connection keeps its refresh warning when configured changes, resetting only for a different provider", async () => {
  const form = authDetail(async () => Response.json({ success: true, catalog: { completed: false } }));
  form.setProvider({ id: "llama.cpp", displayName: "llama.cpp", configured: false, modelCount: 0 });
  assert.equal(form.routerUrl(), providerListing.DEFAULT_LLAMA_ROUTER_URL);
  assert.deepEqual(form.alerts(), []);
  await form.save(); // onRefresh synchronously rerenders configured: false -> true.
  assert.equal(form.routerUrl(), "", "configured input synchronization still runs");
  assert.deepEqual(form.alerts(), ["models.llamaCatalogUnavailable"]);
  form.setProvider({ id: "llama.cpp", displayName: "llama.cpp", configured: true, modelCount: 0 });
  assert.deepEqual(form.alerts(), ["models.llamaCatalogUnavailable"]);
  form.setProvider({ id: "other", displayName: "Other", configured: false, modelCount: 0 });
  assert.deepEqual(form.alerts(), [], "changing provider identity fully resets the form");
});
