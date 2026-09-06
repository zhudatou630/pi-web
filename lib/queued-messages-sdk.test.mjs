import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createJiti } from "jiti";

const {
  snapshotAgentQueuedMessages,
  parseQueuedDeliverySnapshot,
  queuedPromptFromUnknown,
} = await createJiti(import.meta.url).import("./queued-messages.ts");

const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const jpeg = Buffer.from("ffd8ffe000104a464946", "hex").toString("base64");

function createAgent() {
  return new Agent({
    streamFn() {
      throw new Error("queued-message tests must not send a network prompt");
    },
  });
}

test("installed Agent stores queued ImageContent on delivery-queue messages arrays", () => {
  const agent = createAgent();
  const mixed = {
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image", data: png, mimeType: "image/png" },
      { type: "image", data: jpeg, mimeType: "image/jpeg" },
    ],
    timestamp: Date.now(),
  };
  agent.steer(mixed);
  agent.followUp({
    role: "user",
    content: [{ type: "text", text: "later" }],
    timestamp: Date.now(),
  });

  assert.equal(agent.hasQueuedMessages(), true);
  assert.ok(Array.isArray(agent.steeringQueue.messages));
  assert.ok(Array.isArray(agent.followUpQueue.messages));
  assert.equal(agent.steeringQueue.mode, "one-at-a-time");
  assert.deepEqual(agent.steeringQueue.messages[0].content[1], {
    type: "image",
    data: png,
    mimeType: "image/png",
  });

  const snapshot = snapshotAgentQueuedMessages(agent);
  const parsed = parseQueuedDeliverySnapshot(snapshot);
  assert.equal(parsed.steering[0].text, "look");
  assert.equal(parsed.steering[0].images.length, 2);
  assert.equal(parsed.steering[0].images[1].mimeType, "image/jpeg");
  assert.equal(parsed.followUp[0].text, "later");
  assert.equal(agent.steeringQueue.messages.length, 1);
});

test("drain removes pending delivery messages and recall must not resurrect them", () => {
  const agent = createAgent();
  agent.steer({
    role: "user",
    content: [
      { type: "text", text: "first" },
      { type: "image", data: png, mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });
  agent.steer({
    role: "user",
    content: [{ type: "text", text: "second" }],
    timestamp: Date.now(),
  });

  const drained = agent.steeringQueue.drain();
  assert.equal(drained.length, 1);
  assert.equal(queuedPromptFromUnknown(drained[0]).text, "first");
  assert.equal(agent.steeringQueue.messages.length, 1);
  assert.equal(agent.hasQueuedMessages(), true);

  const remaining = parseQueuedDeliverySnapshot(snapshotAgentQueuedMessages(agent));
  assert.deepEqual(remaining.steering.map((item) => item.text), ["second"]);
  assert.equal(remaining.steering[0].images.length, 0);

  agent.steeringQueue.drain();
  assert.equal(agent.hasQueuedMessages(), false);
  assert.deepEqual(parseQueuedDeliverySnapshot(snapshotAgentQueuedMessages(agent)), {
    steering: [],
    followUp: [],
  });
});

test("custom queued Agent messages fail closed without treating them as user prompts", () => {
  const agent = createAgent();
  agent.steer({
    role: "custom",
    customType: "note",
    content: [{ type: "text", text: "extension" }],
    display: true,
    details: {},
    timestamp: Date.now(),
  });
  const snapshot = snapshotAgentQueuedMessages(agent);
  assert.throws(() => parseQueuedDeliverySnapshot(snapshot), /custom\/extension/);
  assert.equal(agent.steeringQueue.messages.length, 1);
});
