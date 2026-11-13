import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { collectExtensionIssues } = await jiti.import("./extension-diagnostics.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

test("collects service errors/warnings and loader conflicts, preserving paths without duplication", () => {
  assert.deepEqual(collectExtensionIssues({ diagnostics: [{ type: "error", message: "bad provider", path: "/provider" }, { type: "info", message: "ok" }], extensions: { errors: [{ path: "/broken", error: "parse /broken:1" }], warnings: [{ path: "/old", warning: "deprecated" }] } }), [
    { type: "error", message: "/provider: bad provider" }, { type: "error", message: "parse /broken:1" }, { type: "warning", message: "/old: deprecated" },
  ]);
});
function fixture(t) {
  let bindings;
  let errors = [];
  const inner = { sessionId: "diagnostics", agent: { state: {} }, sessionManager: { getCwd: () => "/tmp" }, extensionRunner: {}, dispose() {},
    resourceLoader: { getExtensions: () => ({ errors, warnings: [{ path: "/old", warning: "warning" }] }) },
    async bindExtensions(value) { bindings = value; value.onError({ extensionPath: "/start", event: "session_start", error: "boom" }); },
    getActiveToolNames: () => [], setActiveToolsByName() {}, settingsManager: { setProjectTrusted() {} }, async reload() { bindings.onError({ extensionPath: "/reload", event: "session_start", error: "reload boom" }); },
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const heard = () => { const events = []; const unsubscribe = wrapper.onEvent((event) => events.push(event)); unsubscribe(); return events; };
  return { wrapper, heard, setErrors: (value) => { errors = value; } };
}
test("each subscriber gets the same bounded startup issues, every issue is logged", async (t) => {
  const f = fixture(t);
  const log = t.mock.method(console, "warn", () => {});
  f.setErrors(Array.from({ length: 20 }, (_, i) => ({ path: `/error${i}`, error: "broken" })));
  f.wrapper.beginExtensionBinding();
  await f.wrapper.waitUntilReady();
  f.wrapper.reportExtensionIssues([{ type: "error", message: "service diagnostic" }]);
  assert.equal(log.mock.calls.length, 23);
  const first = f.heard();
  assert.equal(first.length, 8);
  assert.equal(first[0].type, "extension_error");
  assert.equal(first.at(-1).messageKey, "chat.extensionIssuesOmitted");
  assert.deepEqual(f.heard(), first);
});
for (const command of [true, false]) {
  test(`${command ? "/reload" : "ctx.reload"} replaces stale issues and retains session_start errors`, async (t) => {
    const f = fixture(t);
    f.wrapper.beginExtensionBinding(); await f.wrapper.waitUntilReady();
    f.setErrors([{ path: "/fixed-later", error: "broken" }]);
    f.wrapper.reportExtensionIssues();
    f.setErrors([]);
    if (command) await f.wrapper.send({ type: "reload" });
    else await f.wrapper.createExtensionCommandContextActions().reload();
    assert.equal(f.heard().length, 2);
    assert.equal(f.heard()[0].extensionPath, "/reload");
    assert.ok(!f.heard().some((event) => String(event.message).includes("fixed-later")));
  });
}
