import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  normalizeStreamingToolCalls,
  normalizeToolCalls,
  projectMessageForBrowser,
} = await jiti.import("./normalize.ts");

test("browser projection strips only assistant block signatures without mutating source data", () => {
  const signatures = { thinkingSignature: "thinking-secret", textSignature: "text-secret", thoughtSignature: "tool-secret" };
  const args = { ...signatures, nested: { ...signatures } };
  const message = assistant({ type: "text", text: "answer", ...signatures });
  message.content.push(
    { type: "thinking", thinking: "", ...signatures },
    { type: "toolCall", id: "call", name: "test", arguments: args, ...signatures },
    { type: "toolCall", toolCallId: "normalized", toolName: "test", input: args, ...signatures },
  );
  message.thinkingSignature = "message-level data";
  const original = structuredClone(message);
  for (const block of message.content) Object.freeze(block);
  Object.freeze(message.content);
  Object.freeze(message);

  const projected = projectMessageForBrowser(message);
  assert.notStrictEqual(projected, message);
  assert.notStrictEqual(projected.content, message.content);
  for (let i = 0; i < projected.content.length; i++) {
    assert.notStrictEqual(projected.content[i], message.content[i]);
    for (const field of Object.keys(signatures)) assert.equal(Object.hasOwn(projected.content[i], field), false);
  }
  assert.strictEqual(projected.content[2].arguments, args);
  assert.strictEqual(projected.content[3].input, args);
  assert.equal(projected.thinkingSignature, "message-level data");
  assert.deepEqual(message, original);
  assert.strictEqual(projectMessageForBrowser(projected), projected);
});

test("browser projection preserves non-assistant and malformed messages", () => {
  for (const message of [null, undefined, "text", [], {},
    { role: "assistant", content: "legacy" },
    { role: "assistant", content: [null, "text", {}, { type: "text", text: "ok" }] },
    ...["user", "toolResult", "custom", "system"].map((role) => ({
      role, content: [{ type: "text", textSignature: "keep" }],
    })),
  ]) assert.strictEqual(projectMessageForBrowser(message), message);
});

function assistant(block) {
  return {
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  };
}

test("keeps the snapshot's raw input only for an in-flight snapshot", () => {
  const message = assistant({
    type: "toolCall",
    id: "call-1",
    name: "write",
    arguments: { path: "/tmp/file" },
    rawInput: '{"path":"/tmp/file","content":"hel',
  });

  assert.deepEqual(normalizeStreamingToolCalls(message).content[0], {
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "write",
    input: { path: "/tmp/file" },
    rawInput: '{"path":"/tmp/file","content":"hel',
  });
  assert.deepEqual(normalizeToolCalls(message).content[0], {
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "write",
    input: { path: "/tmp/file" },
  });
});

test("removes a client raw buffer when normalizing a completed message", () => {
  const message = assistant({
    type: "toolCall",
    toolCallId: "call-2",
    toolName: "write",
    input: { path: "/tmp/file", content: "complete" },
    rawInput: "temporary",
  });

  assert.equal(Object.hasOwn(normalizeToolCalls(message).content[0], "rawInput"), false);
});
