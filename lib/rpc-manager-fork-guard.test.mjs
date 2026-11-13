import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-fork-guard-"));
  const dir = join(root, "sessions");
  await mkdir(dir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, dir);
  const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  let ui;
  const asked = [];
  const dialogs = [];
  const runner = {
    hasHandlers: () => true,
    async emit(event) {
      if (event.type !== "session_before_fork") return;
      asked.push(event);
      try { return { cancel: !await ui.confirm("Guard", "Copy?") }; } catch { /* pi swallows hook errors */ }
    },
  };
  const inner = {
    sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionManager: manager,
    isStreaming: false, isCompacting: false, isBashRunning: false,
    agent: { state: {}, steeringQueue: { messages: [] }, followUpQueue: { messages: [] } },
    extensionRunner: runner,
    async bindExtensions(bindings) { await tick(); ui = bindings.uiContext; },
    async abort() {}, clearQueue: () => ({ steering: [], followUp: [] }),
    getActiveToolNames: () => [], setActiveToolsByName() {},
    async navigateTree() { return { cancelled: !await ui.confirm("Tree", "Move?") }; },
    async compact() { return ui.confirm("Compact", "Compact?"); },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.beginExtensionBinding();
  wrapper.onEvent((event) => { if (event.method === "confirm") dialogs.push(event); });
  const nextDialog = async () => {
    for (let i = 0; !dialogs.length && i < 100; i++) await tick();
    assert.ok(dialogs.length, "extension must have UI once bound");
    return dialogs.shift();
  };
  return { wrapper, inner, manager, first, asked, nextDialog, files: () => readdir(dir) };
}
for (const type of ["fork", "clone"]) {
  test(`${type} asks a bound guard outside the copy lock; Stop cancels instead of approving`, async (t) => {
    const s = await fixture(t);
    await s.wrapper.send({ type: "abort" });
    const copying = s.wrapper.send({ type, entryId: s.first, leafId: s.manager.getLeafId() });
    await s.nextDialog();
    assert.equal(s.wrapper.sessionReplacement, null);
    await s.wrapper.send({ type: "abort" });
    assert.deepEqual(await copying, { cancelled: true, ...(type === "clone" ? { byExtension: true } : {}) });
    assert.equal((await s.files()).length, 1);
    assert.equal(s.asked[0].position, type === "fork" ? "before" : "at");
  });
  test(`${type} rechecks busy state after an extension dialog`, async (t) => {
    const s = await fixture(t);
    const copying = s.wrapper.send({ type, entryId: s.first, leafId: s.manager.getLeafId() });
    const dialog = await s.nextDialog();
    s.inner.isStreaming = true;
    await s.wrapper.send({ type: "extension_ui_response", id: dialog.id, confirmed: true });
    await assert.rejects(copying, /while the session is running/);
    assert.equal((await s.files()).length, 1);
  });
}
for (const type of ["navigate_tree", "compact"]) {
  test(`${type} renews the extension UI controller after Stop`, async (t) => {
    const s = await fixture(t);
    await s.wrapper.send({ type: "abort" });
    const operation = s.wrapper.send({ type, targetId: s.first });
    const dialog = await s.nextDialog();
    await s.wrapper.send({ type: "extension_ui_response", id: dialog.id, confirmed: false });
    assert.deepEqual(await operation, type === "compact" ? false : { cancelled: true });
  });
}
