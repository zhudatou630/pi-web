import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./models/ModelDetail.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("ModelDetail.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}
function evaluate(node, bindings) {
  const js = ts.transpileModule(`return (${node.getText(file)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
function callback(name, bindings) {
  const declaration = find(file, (node) => ts.isVariableDeclaration(node) && node.name.getText(file) === name);
  assert.ok(declaration, name);
  return evaluate(declaration.initializer.arguments[0], bindings);
}

test("connection test ignores late success, HTTP failure and rejection after edits or unmount", async () => {
  const effect = find(file, (node) => ts.isCallExpression(node) && node.expression.getText(file) === "useEffect"
    && node.arguments[0].getText(file).includes("testRequestIdRef"));
  assert.ok(effect);
  // Content, not object identity: an unrelated parent render must not drop a running test.
  assert.equal(effect.arguments[1].getText(file), "[testDraftKey]");
  assert.match(source, /const testDraftKey = JSON\.stringify\(\[providerName, provider, model, cwd\]\);/);
  for (const outcome of ["success", "http-error", "reject"]) {
    const testRequestIdRef = { current: 0 };
    let state;
    const pending = [];
    const bindings = {
      testRequestIdRef, setTestState: (next) => { state = next; },
      providerName: "fixture", provider: { baseUrl: "https://provider.invalid" },
      model: { id: "one", baseUrl: "https://model.invalid/v1" }, cwd: null,
      testState: { phase: "idle" }, t: (key) => key,
      fetch: async (_url, options) => {
        assert.equal(JSON.parse(options.body).model.baseUrl, "https://model.invalid/v1");
        const deferred = Promise.withResolvers();
        pending.push(deferred);
        return deferred.promise;
      },
    };
    const reset = evaluate(effect.arguments[0], bindings);
    let cleanup = reset();
    const old = callback("handleTest", bindings)();
    assert.equal(state.phase, "testing");
    cleanup(); // React cleans up before running the effect for a new draft.
    cleanup = reset();
    const current = callback("handleTest", bindings)();
    pending[1].resolve({ ok: true, json: async () => ({ ok: true, responseText: "new" }) });
    await current;
    if (outcome === "reject") pending[0].reject(new Error("old"));
    else pending[0].resolve({ ok: outcome === "success", status: 500, json: async () => ({ ok: outcome === "success", error: "old", responseText: "old" }) });
    await old;
    assert.equal(state.phase, "success");
    assert.equal(state.responseText, "new");

    const unmounted = callback("handleTest", bindings)();
    cleanup();
    pending[2].resolve({ ok: true, json: async () => ({ ok: true, responseText: "unmounted" }) });
    await unmounted;
    assert.equal(state.phase, "testing", "unmounted result must not update state");
  }
});

test("catalog Fill queries the effective model URL, falling back to the provider", async () => {
  for (const baseUrl of [undefined, "https://model.invalid/v1"]) {
    const model = { id: "one", baseUrl };
    const provider = { baseUrl: "https://provider.invalid" };
    const expression = find(file, (node) => ts.isVariableDeclaration(node) && node.name.getText(file) === "effectiveBaseUrl");
    const effectiveBaseUrl = evaluate(expression.initializer, { model, provider });
    let queried;
    await callback("handleCatalogFill", {
      model, providerName: "fixture", effectiveBaseUrl, cwd: null,
      catalogState: { phase: "idle" }, catalogRequestIdRef: { current: 0 },
      setCatalogState: () => {},
      fetch: async (url) => { queried = new URL(url, "http://localhost"); return { ok: false, status: 400, json: async () => ({ error: "fixture" }) }; },
    })();
    assert.equal(queried.searchParams.get("baseUrl"), baseUrl ?? provider.baseUrl);
  }
});
