import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const refusal = "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
function setup(t) {
  let emit;
  const calls = [], events = [];
  const inner = {
    sessionId: "compaction-queue", isCompacting: true, isStreaming: false, isBashRunning: false,
    agent: { state: {}, steeringQueue: { messages: [] }, followUpQueue: { messages: [] } },
    sessionManager: { getCwd: () => "/tmp", getEntries: () => [], getSessionName: () => undefined },
    settingsManager: { getImageAutoResize: () => false }, extensionRunner: {},
    subscribe: (listener) => { emit = listener; return () => {}; }, dispose() {},
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    clearQueue: () => ({ steering: [], followUp: [] }),
    prompt: async (text, options) => {
      if (text === "/extension") { options.preflightResult("handled"); return; }
      if (inner.isCompacting) throw new Error(refusal);
      calls.push([text, options]);
      options.preflightResult("started");
    },
    abortCompaction() { inner.isCompacting = false; emit({ type: "compaction_end", reason: "manual", aborted: true }); },
    async abort() { inner.abortCompaction(); },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));
  t.after(() => wrapper.destroy());
  return { inner, wrapper, calls, events, emit: (event) => emit(event), end: (extra = {}) => {
    inner.isCompacting = false;
    emit({ type: "compaction_end", reason: "manual", ...extra });
  }, send: (message, streamingBehavior, images) => wrapper.send({ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}), ...(images ? { images } : {}) }) };
}

test("manual compaction refusals are parked with queued acknowledgements and recalled with images", async (t) => {
  const h = setup(t);
  assert.deepEqual(await h.send("first", undefined, [image]), { queued: true });
  assert.deepEqual(await h.send("later", "followUp"), { queued: true });
  const state = await h.wrapper.send({ type: "get_state" });
  assert.deepEqual(state.queuedMessages, { steering: ["first"], followUp: ["later"] });
  assert.equal(state.isPromptRunning, true);
  assert.equal(h.wrapper.isRunning(), true);
  const recalled = await h.wrapper.send({ type: "clear_queue" });
  assert.equal(recalled.steering[0].text, "first");
  assert.deepEqual(recalled.steering[0].images, [image]);
  assert.equal(recalled.followUp[0].text, "later");
  h.end(); await tick();
  assert.deepEqual(h.calls, []);
  assert.equal(h.wrapper.isRunning(), false);
  assert.equal(h.events.filter((e) => e.type === "prompt_done").length, 1);
});

for (const ending of [{}, { errorMessage: "failed" }, { aborted: true }]) {
  test(`flushes FIFO on compaction end ${JSON.stringify(ending)}, through serialized preflight`, async (t) => {
    const h = setup(t);
    await h.send("slow"); await h.send("fast");
    const first = Promise.withResolvers();
    h.inner.prompt = async (text, options) => {
      if (text === "slow") await first.promise;
      h.calls.push([text, options]);
      options.preflightResult("started");
    };
    h.end(ending);
    const newest = h.send("newest", "steer");
    await tick();
    assert.deepEqual(h.calls, []);
    first.resolve();
    await newest; await tick();
    assert.deepEqual(h.calls.map(([text]) => text), ["slow", "fast", "newest"]);
    assert.equal(h.calls[0][1].streamingBehavior, "steer");
    assert.deepEqual((await h.wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });
    assert.equal(h.wrapper.isRunning(), false);
  });
}

test("Recall during the first flush preflight still takes back later messages", async (t) => {
  const h = setup(t);
  await h.send("first"); await h.send("recall me", undefined, [image]);
  const first = Promise.withResolvers();
  h.inner.prompt = async (text, options) => {
    h.calls.push([text, options]);
    await first.promise;
    options.preflightResult("started");
  };
  h.end(); await tick();
  const recalled = await h.wrapper.send({ type: "clear_queue" });
  assert.equal(recalled.steering[0].text, "recall me");
  assert.deepEqual(recalled.steering[0].images, [image]);
  first.resolve(); await tick();
  assert.deepEqual(h.calls.map(([text]) => text), ["first"]);
});

test("extension commands still run; unrelated errors during auto-compaction are not parked", async (t) => {
  const h = setup(t);
  assert.equal(await h.send("/extension"), null);
  h.inner.prompt = async () => { throw new Error("input handler failed"); };
  await assert.rejects(h.send("not a compaction refusal", "steer"), /input handler failed/);
  assert.deepEqual((await h.wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });
});

test("a late SDK refusal after compaction_end does not strand a prompt", async (t) => {
  const h = setup(t);
  const refusing = Promise.withResolvers();
  let first = true;
  h.inner.prompt = async (text, options) => {
    if (first) { first = false; await refusing.promise; throw new Error(refusal); }
    h.calls.push([text, options]); options.preflightResult("started");
  };
  const sending = h.send("late");
  await tick(); h.end(); refusing.resolve();
  assert.deepEqual(await sending, { queued: true }); await tick();
  assert.deepEqual(h.calls.map(([text]) => text), ["late"]);
  assert.equal(h.wrapper.isRunning(), false);
});

test("Stop before a late refusal leaves it recallable, never starts a fresh run", async (t) => {
  const h = setup(t);
  const refused = Promise.withResolvers();
  let first = true;
  h.inner.prompt = async (text, options) => {
    if (first) { first = false; await refused.promise; throw new Error(refusal); }
    h.calls.push([text, options]); options.preflightResult("started");
  };
  const sending = h.send("late stopped", undefined, [image]);
  await tick();
  await h.wrapper.send({ type: "abort" });
  refused.resolve(); await sending; await tick();
  assert.deepEqual(h.calls, []);
  const recalled = await h.wrapper.send({ type: "abort" });
  assert.deepEqual(recalled.steering[0].images, [image]);
});

test("a rejected flush remains recallable but a post-accept failure is never resent", async (t) => {
  for (const accepted of [false, true]) {
    const h = setup(t);
    await h.send("keep or finish");
    h.inner.prompt = async (_text, options) => {
      if (accepted) options.preflightResult("started");
      throw new Error("delivery failed");
    };
    h.end(); await tick();
    assert.equal(h.wrapper.isRunning(), false);
    const recalled = await h.wrapper.send({ type: "clear_queue" });
    assert.equal(recalled.steering.length, accepted ? 0 : 1);
    assert.ok(h.events.some((e) => e.type === "prompt_error"));
  }
});

test("Stop compaction flushes only actual parked prompts; Stop recalls them before aborting", async (t) => {
  for (const command of ["abort_compaction", "abort"]) {
    const h = setup(t);
    await h.send("parked", undefined, [image]);
    const result = await h.wrapper.send({ type: command }); await tick();
    assert.equal(h.calls.length, command === "abort" ? 0 : 1);
    if (command === "abort") assert.deepEqual(result.steering[0].images, [image]);
  }
  const empty = setup(t);
  await empty.wrapper.send({ type: "abort_compaction" }); await tick();
  assert.deepEqual(empty.calls, []);
});
