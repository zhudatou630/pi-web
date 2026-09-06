import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  QueuedDeliveryError,
  snapshotAgentQueuedMessages,
  queuedPromptFromUnknown,
  parseQueuedDeliverySnapshot,
  recalledQueuedPrompts,
} = await createJiti(import.meta.url).import("./queued-messages.ts");

const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const jpeg = Buffer.from("ffd8ffe000104a464946", "hex").toString("base64");

function userMessage(content) {
  return { role: "user", content, timestamp: 1 };
}

test("snapshots full agent queue messages without inventing a client cache", () => {
  const agent = {
    steeringQueue: {
      messages: [
        userMessage([{ type: "text", text: "look" }, { type: "image", data: png, mimeType: "image/png" }]),
      ],
    },
    followUpQueue: {
      messages: [
        userMessage([{ type: "image", data: jpeg, mimeType: "image/jpeg" }]),
      ],
    },
    hasQueuedMessages() {
      return true;
    },
  };
  const snapshot = snapshotAgentQueuedMessages(agent);
  assert.equal(snapshot.steering.length, 1);
  const steering = queuedPromptFromUnknown(snapshot.steering[0]);
  assert.equal(steering.text, "look");
  assert.equal(steering.images[0].mimeType, "image/png");
  assert.equal(queuedPromptFromUnknown(snapshot.followUp[0]).images[0].data, jpeg);
});

test("throws when the private agent queues are unavailable", () => {
  assert.throws(() => snapshotAgentQueuedMessages({}), QueuedDeliveryError);
  assert.throws(() => snapshotAgentQueuedMessages(null), QueuedDeliveryError);
  assert.throws(() => snapshotAgentQueuedMessages({ steeringQueue: {}, followUpQueue: { messages: [] } }), QueuedDeliveryError);
});

test("throws when pending state disagrees with readable delivery messages", () => {
  const agent = {
    steeringQueue: { messages: [userMessage("look")] },
    followUpQueue: { messages: [] },
    hasQueuedMessages() {
      return false;
    },
  };
  assert.throws(() => snapshotAgentQueuedMessages(agent), /pending state/);
});

test("parses delivery-queue messages and keeps every image", () => {
  const pngMessage = userMessage([
    { type: "text", text: "same" },
    { type: "image", data: png, mimeType: "image/png" },
    { type: "image", data: jpeg, mimeType: "image/jpeg" },
  ]);
  const parsed = parseQueuedDeliverySnapshot({ steering: [pngMessage], followUp: [] });
  assert.equal(parsed.steering[0].images.length, 2);
  assert.equal(parsed.steering[0].text, "same");
  assert.equal(parsed.steering[0].images[1].mimeType, "image/jpeg");
});

test("empty delivery queues stay empty even if public strings still exist", () => {
  const drained = parseQueuedDeliverySnapshot({ steering: [], followUp: [] });
  assert.deepEqual(drained, { steering: [], followUp: [] });
});

test("rejects unsupported runtime shapes instead of skipping content", () => {
  assert.throws(() => queuedPromptFromUnknown("plain"), QueuedDeliveryError);
  assert.throws(() => queuedPromptFromUnknown({ role: "custom", customType: "note", content: [] }), /custom\/extension/);
  assert.throws(() => queuedPromptFromUnknown({ role: "assistant", content: "nope" }), /not a user message/);
  assert.throws(
    () => queuedPromptFromUnknown(userMessage([{ type: "image", source: { type: "url", url: "https://example" } }])),
    /cannot be restored/,
  );
  assert.throws(
    () => queuedPromptFromUnknown(userMessage([{ type: "toolCall", id: "1" }])),
    /Unsupported queued content type/,
  );
});

test("recall accepts mixed string and full-message payloads without duplicating or dropping extras", () => {
  const images = Array.from({ length: 11 }, (_, index) => ({
    data: png + Buffer.from(String(index)).toString("base64"),
    mimeType: "image/png",
  }));
  const recalled = recalledQueuedPrompts([
    "plain",
    { text: "mixed", images },
  ]);
  assert.equal(recalled.length, 2);
  assert.deepEqual(recalled[0], { text: "plain", images: [] });
  assert.equal(recalled[1].images.length, 11);
});

test("identical text with different attachments stays distinct", () => {
  const first = queuedPromptFromUnknown(userMessage([
    { type: "text", text: "same" },
    { type: "image", data: png, mimeType: "image/png" },
  ]));
  const second = queuedPromptFromUnknown(userMessage([
    { type: "text", text: "same" },
    { type: "image", data: jpeg, mimeType: "image/jpeg" },
  ]));
  assert.equal(first.text, second.text);
  assert.notEqual(first.images[0].data, second.images[0].data);
});
