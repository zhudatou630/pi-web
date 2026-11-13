import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const ui = await jiti.import("./SettingsUi.tsx");
const { enLocale: en } = await jiti.import("../lib/i18n/messages/en.ts");
const { zhCNLocale: zh } = await jiti.import("../lib/i18n/messages/zh-CN.ts");
const compiled = ts.transpileModule(readFileSync(new URL("./SettingsScope.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function scope(locale = en) {
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    if (name === "@/hooks/useI18n") return { useI18n: () => ({ t: (key) => locale.messages[key] }) };
    if (name === "./SettingsUi") return ui;
    if (name === "react/jsx-runtime") return jsxRuntime;
    throw new Error(`Unexpected import: ${name}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

function buttons(node, result = []) {
  if (Array.isArray(node)) { node.forEach((child) => buttons(child, result)); return result; }
  if (!React.isValidElement(node)) return result;
  if (typeof node.type === "function") return buttons(node.type(node.props), result);
  if (node.type === "button") result.push(node.props);
  buttons(node.props.children, result);
  return result;
}

for (const locale of [en, zh]) {
  test(`${locale.id}: global and project rows share labels, status, path and reset affordance`, () => {
    const { SettingsScopeRow } = scope(locale);
    const props = { checked: false, onChange() {} };
    const html = (extra) => renderToStaticMarkup(React.createElement(SettingsScopeRow, { ...props, ...extra }));
    const global = html({});
    assert.ok(global.includes(locale.messages["settings.scope.default"]));
    assert.ok(!global.includes(locale.messages["settings.scope.follows"]));
    assert.doesNotMatch(global, /settings-row-description|settings-chat-reset/);
    for (const path of ["/home/person/pi-web", "C:\\projects\\pi-web\\"]) {
      const inherited = html({ projectPath: path, overridden: false });
      assert.match(inherited, />pi-web<|>pi-web<\/span>/);
      assert.ok(inherited.includes(`title="${path}"`));
      assert.ok(inherited.includes(locale.messages["settings.scope.follows"]));
      assert.doesNotMatch(inherited, /settings-chat-reset/);
    }
    const own = html({ projectPath: "/repo", overridden: true, onReset() {} });
    assert.match(own, /settings-row-status/);
    assert.ok(own.includes(`aria-label="${locale.messages["settings.scope.reset"]}"`));
    assert.ok(!own.includes(locale.messages["settings.scope.follows"]));
  });
}

test("project toggles and reset call separate existing save paths; false is still an override", () => {
  const { SettingsScopeControl } = scope();
  const changes = [];
  let resets = 0;
  const control = SettingsScopeControl({ checked: false, label: "repo", overridden: true, onChange: (next) => changes.push(next), onReset: () => resets++ });
  const [toggle, reset] = buttons(control);
  assert.equal(toggle["aria-checked"], false);
  toggle.onClick();
  assert.deepEqual(changes, [true]);
  reset.onClick();
  assert.equal(resets, 1);
  for (const state of [{ disabled: true }, { loading: true }]) {
    const locked = buttons(SettingsScopeControl({ checked: true, label: "repo", overridden: true, onChange() {}, onReset() {}, ...state }));
    assert.ok(locked.every((button) => button.disabled));
  }
});
