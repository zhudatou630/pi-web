import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  isEventIncludedInSnapshot,
  StreamingToolInput,
  toClientAgentEvent,
} = await jiti.import("./agent-event-wire.ts");

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: 1,
  };
}

test("bash wire sends replaceable snapshots, never SDK per-chunk deltas", () => {
  assert.equal(toClientAgentEvent({ type: "bash_execution_update", delta: "large chunk" }), null);
  const event = { type: "bash_output", id: "run", command: "pwd", startedAt: 1, excludeFromContext: false, output: "tail" };
  assert.deepEqual(toClientAgentEvent(event), event);
});

test("wire projection removes signatures from assistant starts, ends and update payloads", () => {
  const toolCall = {
    type: "toolCall", id: "call", name: "test", thoughtSignature: "provider-secret",
    arguments: { thoughtSignature: "user argument" },
  };
  const message = assistantMessage("answer");
  message.content[0].textSignature = "provider-secret";
  message.content.push({ type: "thinking", thinking: "", thinkingSignature: "provider-secret" }, toolCall);
  const original = structuredClone(message);
  for (const type of ["message_start", "message_end"]) {
    const projected = toClientAgentEvent({ type, message });
    assert.equal(JSON.stringify(projected).includes("provider-secret"), false);
    assert.equal(projected.message.content[2].arguments.thoughtSignature, "user argument");
  }
  for (const update of [
    { type: "toolcall_end", contentIndex: 2, toolCall, partial: message },
    { type: "toolcall_end", contentIndex: 2, toolCall },
    { type: "done", reason: "stop", message },
    { type: "error", reason: "error", error: message },
    { type: "thinking_start", contentIndex: 1, partial: message },
  ]) {
    const event = { type: "message_update", message, assistantMessageEvent: update };
    const before = structuredClone(event);
    const projected = toClientAgentEvent(event);
    assert.equal(JSON.stringify(projected).includes("provider-secret"), false);
    assert.deepEqual(event, before);
  }
  assert.deepEqual(message, original);
});

test("projects message_update onto Pi 0.84's JSON/RPC delta shape", () => {
  const partial = assistantMessage("Hello");
  const projected = toClientAgentEvent({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "o",
      partial,
    },
  });

  assert.deepEqual(projected, {
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "o",
    },
  });
  assert.equal(Object.hasOwn(projected, "message"), false);
  assert.equal(Object.hasOwn(projected.assistantMessageEvent, "partial"), false);
});

test("keeps tool identity on toolcall_start without sending the cumulative partial", () => {
  const partial = {
    ...assistantMessage(""),
    content: [{
      type: "toolCall",
      id: "call-write-1",
      name: "write",
      arguments: {},
      partialJson: "",
    }],
  };
  const projected = toClientAgentEvent({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 0,
      partial,
    },
  });

  assert.deepEqual(projected, {
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 0,
      id: "call-write-1",
      toolName: "write",
    },
  });
  assert.equal(Object.hasOwn(projected, "message"), false);
  assert.equal(Object.hasOwn(projected.assistantMessageEvent, "partial"), false);
});

test("refreshes late tool identity on toolcall_delta", () => {
  const partial = {
    ...assistantMessage(""),
    content: [{
      type: "toolCall",
      id: "call-late-1",
      name: "write",
      arguments: { path: "/tmp/file" },
      partialJson: '{"path":"/tmp/file"',
    }],
  };
  const projected = toClientAgentEvent({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '"/tmp/file"',
      partial,
    },
  });

  assert.deepEqual(projected, {
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '"/tmp/file"',
      id: "call-late-1",
      toolName: "write",
    },
  });
});

test("does not whitelist assistant delta event types", () => {
  const projected = toClientAgentEvent({
    type: "message_update",
    message: assistantMessage("future"),
    assistantMessageEvent: {
      type: "future_delta",
      contentIndex: 3,
      value: "kept",
      partial: assistantMessage("future"),
    },
  });

  assert.deepEqual(projected, {
    type: "message_update",
    assistantMessageEvent: {
      type: "future_delta",
      contentIndex: 3,
      value: "kept",
    },
  });
});

test("rejects a malformed message_update without breaking the stream", () => {
  assert.equal(toClientAgentEvent({
    type: "message_update",
    assistantMessageEvent: null,
  }), null);
});

test("recognizes only the in-flight event already covered by a snapshot", () => {
  const snapshot = assistantMessage("Hello");
  assert.equal(isEventIncludedInSnapshot({
    type: "message_update",
    message: snapshot,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "o" },
  }, snapshot), true);
  assert.equal(isEventIncludedInSnapshot({
    type: "message_update",
    message: { ...snapshot },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!" },
  }, snapshot), false);
  assert.equal(isEventIncludedInSnapshot({
    type: "message_end",
    message: snapshot,
  }, snapshot), false);
});

test("keeps the existing event omissions and slim agent_end", () => {
  assert.equal(toClientAgentEvent({ type: "turn_start" }), null);
  assert.equal(toClientAgentEvent({ type: "turn_end" }), null);
  assert.deepEqual(
    toClientAgentEvent({ type: "agent_end", messages: [assistantMessage("done")] }),
    { type: "agent_end" },
  );

  const messageStart = { type: "message_start", message: assistantMessage("") };
  assert.strictEqual(toClientAgentEvent(messageStart), messageStart);
});

test("forwards tool execution progress without repeating tool arguments", () => {
  const partialResult = {
    content: [{ type: "text", text: "Running phase 2" }],
    details: { phase: 2 },
  };

  assert.deepEqual(toClientAgentEvent({
    type: "tool_execution_update",
    toolCallId: "call-workflow-1",
    toolName: "workflow",
    args: { large: "repeated input" },
    partialResult,
  }), {
    type: "tool_execution_update",
    toolCallId: "call-workflow-1",
    toolName: "workflow",
    partialResult,
  });
});

function projectedStreamBytes(totalLength) {
  const chunkSize = 64;
  let text = "";
  let bytes = 0;

  for (let offset = 0; offset < totalLength; offset += chunkSize) {
    const delta = "x".repeat(Math.min(chunkSize, totalLength - offset));
    text += delta;
    const partial = assistantMessage(text);
    const projected = toClientAgentEvent({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta,
        partial,
      },
    });

    assert.equal(Object.hasOwn(projected, "message"), false);
    assert.equal(Object.hasOwn(projected.assistantMessageEvent, "partial"), false);
    bytes += Buffer.byteLength(JSON.stringify(projected));
  }

  return bytes;
}

test("serialized streaming traffic grows linearly with response length", () => {
  const twoKiB = projectedStreamBytes(2 * 1024);
  const fourKiB = projectedStreamBytes(4 * 1024);
  assert.ok(fourKiB / twoKiB < 2.2, `expected near-linear growth, got ${fourKiB / twoKiB}`);
});

function projectedToolStreamBytes(totalLength) {
  const chunkSize = 64;
  let rawInput = "";
  let bytes = 0;

  for (let offset = 0; offset < totalLength; offset += chunkSize) {
    const delta = "x".repeat(Math.min(chunkSize, totalLength - offset));
    rawInput += delta;
    const partial = {
      ...assistantMessage(""),
      content: [{
        type: "toolCall",
        id: "call-write-1",
        name: "write",
        arguments: { content: rawInput },
        partialJson: rawInput,
      }],
    };
    const projected = toClientAgentEvent({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta,
        partial,
      },
    });

    assert.equal(Object.hasOwn(projected, "message"), false);
    assert.equal(Object.hasOwn(projected.assistantMessageEvent, "partial"), false);
    bytes += Buffer.byteLength(JSON.stringify(projected));
  }

  return bytes;
}

test("serialized tool-input traffic grows linearly with write content", () => {
  const twoKiB = projectedToolStreamBytes(2 * 1024);
  const fourKiB = projectedToolStreamBytes(4 * 1024);
  assert.ok(fourKiB / twoKiB < 2.2, `expected near-linear growth, got ${fourKiB / twoKiB}`);
});

test("sends only the role of a non-assistant message_start; message_end keeps the body", () => {
  const toolResult = { role: "toolResult", toolCallId: "t1", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] };
  assert.deepEqual(toClientAgentEvent({ type: "message_start", message: toolResult }), { type: "message_start", message: { role: "toolResult" } });
  assert.equal(toClientAgentEvent({ type: "message_end", message: toolResult }).message, toolResult);
  const assistant = assistantMessage("hi");
  assert.equal(toClientAgentEvent({ type: "message_start", message: assistant }).message, assistant);
});

test("StreamingToolInput gives the snapshot of the last seen update its raw tool input", () => {
  const tracker = new StreamingToolInput();
  const block = { type: "toolCall", id: "call-1", name: "write", arguments: { path: "/tmp/f" } };
  const update = (type, extra = {}) => {
    const message = { ...assistantMessage(""), content: [{ type: "text", text: "x" }, block] };
    tracker.observe({ type: "message_update", message, assistantMessageEvent: { type, contentIndex: 1, ...extra } });
    return message;
  };
  tracker.observe({ type: "message_start", message: assistantMessage("") });
  update("toolcall_start");
  update("toolcall_delta", { delta: '{"path":' });
  const last = update("toolcall_delta", { delta: '"/tmp/f","content":"hel' });

  const projected = tracker.project(last);
  assert.equal(projected.content[1].rawInput, '{"path":"/tmp/f","content":"hel');
  assert.strictEqual(projected.content[0], last.content[0]);
  assert.equal(Object.hasOwn(block, "rawInput"), false, "the SDK's block is not mutated");
  // pi sets its state before listeners run: a newer snapshot than the last seen update gets no raw text.
  const newer = { ...last };
  assert.strictEqual(tracker.project(newer), newer);

  const ended = update("toolcall_end");
  assert.strictEqual(tracker.project(ended), ended);
  tracker.observe({ type: "message_end", message: ended });
  assert.equal(tracker.project(undefined), undefined);
});
