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
