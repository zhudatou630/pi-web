import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); }
  assert.fail("runtime did not settle");
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "batch3b-compaction-sdk-"));
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: dir, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 0 } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  const { session } = await createAgentSessionFromServices({ services, model: faux.getModel("test"), tools: [], sessionManager: SessionManager.inMemory(dir) });
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage([fauxText("OK")])));
  await session.prompt("seed");
  const wrapper = new AgentSessionWrapper(session);
  wrapper.start();
  t.after(async () => { await session.abort(); wrapper.destroy(); await rm(dir, { recursive: true, force: true }); });
  return { session, wrapper, faux };
}

for (const ending of ["success", "failure", "abort"]) {
  test(`installed SDK: manual compaction ${ending} delivers parked prompts in order`, async (t) => {
    const { session, wrapper } = await setup(t);
    const compacting = Promise.withResolvers();
    let preparation;
    session._runDefaultCompaction = async (prep) => {
      preparation = prep;
      await compacting.promise;
      if (ending === "failure") throw new Error("test summary failure");
      return { summary: "tiny summary", firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore };
    };
    const compact = wrapper.send({ type: "compact" });
    compact.catch(() => {});
    await until(() => Boolean(preparation));
    const delivered = [];
    const originalPrompt = session.prompt.bind(session);
    let first = true;
    session.prompt = async (text, options) => {
      // Real SDK refusal; artificially delay only the first delivery's input admission.
      if (!session.isCompacting && first) { first = false; await tick(); await tick(); }
      if (!session.isCompacting) delivered.push(text);
      return originalPrompt(text, options);
    };
    assert.deepEqual(await wrapper.send({ type: "prompt", message: "first" }), { queued: true });
    assert.deepEqual(await wrapper.send({ type: "prompt", message: "second" }), { queued: true });
    if (ending === "abort") await wrapper.send({ type: "abort_compaction" });
    compacting.resolve();
    if (ending === "success") await compact;
    else await assert.rejects(compact, ending === "abort" ? /cancelled/ : /test summary failure/);
    await until(() => delivered.length === 2 && !wrapper.isRunning());
    assert.deepEqual(delivered, ["first", "second"]);
    const users = session.messages.filter((msg) => msg.role === "user").map((msg) => typeof msg.content === "string" ? msg.content : msg.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
    assert.deepEqual(users.slice(-2), ["first", "second"]);
  });
}

test("installed SDK: automatic compaction during a run still accepts steer/follow-up into SDK delivery queues", async (t) => {
  const { session, wrapper, faux } = await setup(t);
  const reply = Promise.withResolvers();
  const started = Promise.withResolvers();
  faux.setResponses([async () => { started.resolve(); await reply.promise; return fauxAssistantMessage([fauxText("OK")]); }]);
  const running = session.prompt("running");
  await started.promise;
  // This is the auto-compaction controller, not the manual-compaction refusal guard.
  session._autoCompactionAbortController = new AbortController();
  assert.equal(session.isCompacting, true);
  await wrapper.send({ type: "prompt", message: "steer", streamingBehavior: "steer" });
  await wrapper.send({ type: "prompt", message: "follow", streamingBehavior: "followUp" });
  assert.deepEqual(session.getSteeringMessages(), ["steer"]);
  assert.deepEqual(session.getFollowUpMessages(), ["follow"]);
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: ["steer"], followUp: ["follow"] });
  const recalled = await wrapper.send({ type: "clear_queue" });
  assert.equal(recalled.steering[0].text, "steer");
  assert.equal(recalled.followUp[0].text, "follow");
  session._autoCompactionAbortController = undefined;
  reply.resolve(); await running;
});
