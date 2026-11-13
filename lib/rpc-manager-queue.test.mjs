import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const jpeg = Buffer.from("ffd8ffe000104a464946", "hex").toString("base64");

function makeInner(overrides = {}) {
  const steeringMessages = ["look"];
  const followUpMessages = [];
  return {
    sessionId: "queue-test-session",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    model: undefined,
    modelRuntime: { getModel: () => undefined, refresh: async () => {} },
    sessionManager: { getCwd: () => process.cwd(), getSessionName: () => undefined },
    settingsManager: { setProjectTrusted: () => {}, getDefaultTools: () => undefined },
    agent: {
      state: {},
      steeringQueue: {
        messages: [
          { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: png, mimeType: "image/png" }] },
        ],
      },
      followUpQueue: { messages: [] },
      hasQueuedMessages() {
        return this.steeringQueue.messages.length > 0 || this.followUpQueue.messages.length > 0;
      },
      clearAllQueues() {
        this.steeringQueue.messages = [];
        this.followUpQueue.messages = [];
      },
    },
    extensionRunner: { getRegisteredCommands: () => [], setUIContext: () => {}, emit: async () => {} },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    subscribe: () => () => {},
    getContextUsage: () => null,
    getSteeringMessages: () => steeringMessages,
    getFollowUpMessages: () => followUpMessages,
    clearQueue() {
      const result = { steering: [...steeringMessages], followUp: [...followUpMessages] };
      steeringMessages.length = 0;
      followUpMessages.length = 0;
      this.agent.clearAllQueues();
      return result;
    },
    getActiveToolNames: () => [],
    getAllTools: () => [],
    setActiveToolsByName: () => {},
    pendingMessageCount: 1,
    dispose: () => {},
    reload: async () => {},
    ...overrides,
  };
}

test("clear_queue returns delivery-queue images instead of string-only SDK output", async (t) => {
  const wrapper = new AgentSessionWrapper(makeInner());
  t.after(() => wrapper.destroy());
  const result = await wrapper.send({ type: "clear_queue" });
  assert.equal(result.steering[0].text, "look");
  assert.equal(result.steering[0].images[0].mimeType, "image/png");
  assert.equal(result.followUp.length, 0);
  const empty = await wrapper.send({ type: "clear_queue" });
  assert.deepEqual(empty, { steering: [], followUp: [] });
});

test("clear_queue keeps every image on a mixed queued message", async (t) => {
  const inner = makeInner();
  inner.agent.steeringQueue.messages = [{
    role: "user",
    content: [
      { type: "text", text: "both" },
      { type: "image", data: png, mimeType: "image/png" },
      { type: "image", data: jpeg, mimeType: "image/jpeg" },
    ],
  }];
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const result = await wrapper.send({ type: "clear_queue" });
  assert.equal(result.steering[0].images.length, 2);
  assert.equal(result.steering[0].images[1].data, jpeg);
});

test("clear_queue fails before clearing when delivery queues are not readable", async (t) => {
  const steeringMessages = ["plain"];
  const followUpMessages = ["later"];
  let cleared = false;
  const inner = makeInner({
    agent: { state: {} },
    getSteeringMessages: () => steeringMessages,
    getFollowUpMessages: () => followUpMessages,
    clearQueue() {
      cleared = true;
      steeringMessages.length = 0;
      followUpMessages.length = 0;
      return { steering: ["plain"], followUp: ["later"] };
    },
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  await assert.rejects(() => wrapper.send({ type: "clear_queue" }), /delivery queue/);
  assert.equal(cleared, false);
  assert.deepEqual(inner.getSteeringMessages(), ["plain"]);
  assert.deepEqual(inner.getFollowUpMessages(), ["later"]);
});

test("clear_queue fails before clearing unsupported or custom queued messages", async (t) => {
  const inner = makeInner();
  inner.agent.steeringQueue.messages = [{
    role: "custom",
    customType: "note",
    content: [{ type: "text", text: "extension" }],
    display: true,
  }];
  let cleared = false;
  inner.clearQueue = () => {
    cleared = true;
    return { steering: [], followUp: [] };
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  await assert.rejects(() => wrapper.send({ type: "clear_queue" }), /custom\/extension/);
  assert.equal(cleared, false);
  assert.equal(inner.agent.steeringQueue.messages.length, 1);
});

test("clear_queue does not return already-drained public strings", async (t) => {
  const steeringMessages = ["already-delivered"];
  const inner = makeInner({
    agent: {
      state: {},
      steeringQueue: { messages: [] },
      followUpQueue: { messages: [] },
      hasQueuedMessages() {
        return false;
      },
      clearAllQueues() {},
    },
    getSteeringMessages: () => steeringMessages,
    pendingMessageCount: 1,
    clearQueue() {
      const result = { steering: [...steeringMessages], followUp: [] };
      steeringMessages.length = 0;
      return result;
    },
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const result = await wrapper.send({ type: "clear_queue" });
  assert.deepEqual(result, { steering: [], followUp: [] });
  assert.deepEqual(inner.getSteeringMessages(), []);
});

test("reload is refused while a turn runs: it would invalidate that turn's extension ctx", async (t) => {
  let reloads = 0;
  const wrapper = new AgentSessionWrapper(makeInner({ isStreaming: true, reload: async () => { reloads += 1; } }));
  t.after(() => wrapper.destroy());
  await assert.rejects(wrapper.send({ type: "reload" }), /Wait for the current response to finish/);
  assert.equal(reloads, 0);
});

test("ctx.reload() warns during a streaming turn and reloads once idle", async (t) => {
  let reloads = 0;
  const inner = makeInner({ isStreaming: true, reload: async () => { reloads += 1; } });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  await wrapper.createExtensionCommandContextActions().reload();
  assert.equal(reloads, 0);
  const warning = events.find((event) => event.type === "extension_ui_request" && event.method === "notify");
  assert.equal(warning?.notifyType, "warning");
  inner.isStreaming = false;
  // A command runs inside its own prompt; a pending prompt alone must not block it.
  await wrapper.createExtensionCommandContextActions().reload();
  assert.equal(reloads, 1);
});

test("a routine run tags its prompt's live user message, and only that one", (t) => {
  let fire;
  const appended = [];
  const inner = makeInner({
    subscribe: (listener) => { fire = listener; return () => {}; },
    sessionManager: { getCwd: () => process.cwd(), getSessionName: () => undefined, appendCustomEntry: (type, data) => appended.push({ type, data }) },
  });
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  t.after(() => wrapper.destroy());
  const seen = [];
  wrapper.onEvent((event) => { if (event.type.startsWith("message_")) seen.push(event.message.routineRun); });
  wrapper.markRoutineRun({ routineId: "rt", runId: "rt:x", mode: "same_session", name: "Daily" });
  assert.deepEqual(appended, [{ type: "pi-web:routine-run", data: { version: 1, routineId: "rt", runId: "rt:x", mode: "same_session", name: "Daily" } }]);
  const prompt = { role: "user", content: "scheduled prompt" };
  fire({ type: "message_start", message: prompt });
  fire({ type: "message_end", message: prompt });
  fire({ type: "message_end", message: { role: "user", content: "typed by hand" } });
  const tag = { routineId: "rt", name: "Daily" };
  assert.deepEqual(seen, [tag, tag, undefined]);
  assert.equal(prompt.routineRun, undefined, "pi's own message object is not mutated");
});

test("a routine run whose prompt ends without a user message tags no later message", (t) => {
  let fire;
  const inner = makeInner({
    subscribe: (listener) => { fire = listener; return () => {}; },
    sessionManager: { getCwd: () => process.cwd(), getSessionName: () => undefined, appendCustomEntry: () => {} },
  });
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  t.after(() => wrapper.destroy());
  const seen = [];
  wrapper.onEvent((event) => { if (event.type === "message_end") seen.push(event.message.routineRun); });
  wrapper.markRoutineRun({ routineId: "rt", runId: "rt:x", mode: "same_session", name: "Daily" });
  wrapper.emit({ type: "prompt_done" }); // a command: no user message
  fire({ type: "message_end", message: { role: "user", content: "typed by hand" } });
  assert.deepEqual(seen, [undefined]);
});

test("ending a routine run closes its marker only when no user message followed it", (t) => {
  const appended = [];
  let branch = [];
  const inner = makeInner({
    sessionManager: {
      getCwd: () => process.cwd(),
      getSessionName: () => undefined,
      appendCustomEntry: (type, data) => { const id = `e${appended.length}`; appended.push({ type, data }); branch.push({ type: "custom", id }); return id; },
      getBranch: () => branch,
    },
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.markRoutineRun({ routineId: "rt", runId: "rt:1", mode: "same_session" });
  branch.push({ type: "message", id: "u1", message: { role: "user", content: "scheduled" } });
  wrapper.endRoutineRun();
  assert.equal(appended.length, 1, "the prompt went out: nothing to close");
  wrapper.markRoutineRun({ routineId: "rt", runId: "rt:2", mode: "same_session" });
  wrapper.endRoutineRun(); // rejected before a user message
  assert.deepEqual(appended.at(-1), { type: "pi-web:routine-run-end", data: { version: 1, runId: "rt:2" } });
  wrapper.endRoutineRun();
  assert.equal(appended.length, 3, "closes once");
});

for (const mode of ["one-at-a-time", "all"]) {
  test(`Stop clears real delivery queues before abort (${mode}) and restores images`, async (t) => {
    const inner = makeInner();
    inner.agent.steeringQueue.messages.push({ role: "user", content: "second" });
    inner.agent.followUpQueue.messages.push({ role: "user", content: "later" });
    let aborted = false;
    inner.abort = async () => {
      aborted = true;
      assert.deepEqual(inner.agent.steeringQueue.messages, []);
      assert.deepEqual(inner.agent.followUpQueue.messages, []);
    };
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    const recalled = await wrapper.send({ type: "abort" });
    assert.equal(aborted, true);
    assert.deepEqual(recalled.steering.map((p) => p.text), ["look", "second"]);
    assert.equal(recalled.steering[0].images[0].data, png);
    assert.deepEqual(recalled.followUp, [{ text: "later", images: [] }]);
    assert.equal(await wrapper.send({ type: "abort" }), null);
  });
}

test("Stop preserves custom identity without triggering another turn", async (t) => {
  const inner = makeInner();
  const custom = { role: "custom", customType: "note", content: "extension", display: true };
  inner.agent.steeringQueue.messages.push(custom);
  const preserved = [];
  inner.sendCustomMessage = async (message, options) => preserved.push({ message, options });
  inner.abort = async () => assert.equal(inner.agent.steeringQueue.messages.length, 0);
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const recalled = await wrapper.send({ type: "abort" });
  assert.deepEqual(recalled.steering.map((p) => p.text), ["look"]);
  assert.deepEqual(preserved, [{ message: custom, options: { triggerTurn: false } }]);
});

test("a malformed recall never destroys its queue and still aborts the work", async (t) => {
  const inner = makeInner();
  inner.agent.steeringQueue.messages[0].content[1].data = "";
  let aborted = false;
  inner.abort = async () => { aborted = true; };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  await assert.rejects(wrapper.send({ type: "abort" }), /cannot be restored/);
  assert.equal(aborted, true);
  assert.equal(inner.agent.steeringQueue.messages.length, 1);
});
