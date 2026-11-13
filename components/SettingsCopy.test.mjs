import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AgentDetail } = await jiti.import("./AgentEditor.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function detail(extra = {}) {
  const profile = { name: "reader", displayName: "Reader", enabled: true, tools: [] };
  const editor = {
    cwd: "/projects/repo", mode: "edit", targetScope: "global", draft: profile, effective: { ...profile, scope: "global" },
    shadowed: [], shown: profile, update() {}, ...extra,
  };
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(AgentDetail, { editor })));
}

test("agent definition state stays separate from project availability, including disable stubs and unsaved copies", () => {
  assert.match(detail(), /Global definition/);
  assert.match(detail(), /On by default/);
  const own = detail({ effective: { scope: "project", enabled: true }, effectiveTag: "project", followsOwnCopy: true });
  assert.match(own, /Project definition/);
  assert.match(own, /↺ Use global version/);
  assert.doesNotMatch(own, /Global definition|Follows default/);
  const stub = detail({ effective: { scope: "project", disableStub: true, enabled: false }, effectiveTag: "project" });
  assert.match(stub, /Global definition/);
  assert.match(stub, /Off in this project/);
  assert.match(stub, /aria-checked="false"/);
  assert.doesNotMatch(stub, /On by default/);
  assert.match(detail({ fixedScope: "project", canCustomize: true }), /Follows default/);
  assert.match(detail({ overriding: true, pendingFile: true, targetScope: "project" }), /Project definition/);
});

const project = ts.createSourceFile("ProjectConfig.tsx", readFileSync(new URL("./ProjectConfig.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function resetResources(post) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(project) === "resetResources") found = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(project);
  assert.ok(found, "test the actual page's reset callback");
  return new Function("post", ts.transpileModule(`return (${found.getText(project)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(post);
}

test("project resets restore each item's own inherited value without touching project-only or unchanged content", async () => {
  const calls = [];
  const reset = resetResources(async (items, enabled) => calls.push([items.map((item) => item.path), enabled]));
  await reset([
    { path: "on", overridden: true, globalEnabled: true },
    { path: "off", overridden: true, globalEnabled: false },
    { path: "unchanged", overridden: false, globalEnabled: true },
    { path: "project-only", overridden: false, globalEnabled: null },
  ]);
  assert.deepEqual(calls, [[["on"], true], [["off"], false]]);
  calls.length = 0;
  await reset([]);
  assert.deepEqual(calls, []);
});

test("project reset failures propagate to the existing page error handler", async () => {
  const reset = resetResources(async () => { throw new Error("save refused"); });
  await assert.rejects(reset([{ path: "on", overridden: true, globalEnabled: true }]), /save refused/);
});
