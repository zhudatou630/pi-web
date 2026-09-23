import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  INITIAL_STREAMING_STATE,
  applyThinkingTimings,
  streamReducer,
} = await jiti.import("./streaming-message.ts");

function assistant(content = []) {
  return {
    role: "assistant",
    content,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    timestamp: 123,
  };
}

function snapshot(state, message) {
  return streamReducer(state, { type: "snapshot", message });
}

function delta(state, event) {
  return streamReducer(state, { type: "delta", event });
}

test("applies a delta batch in order with one reducer action", () => {
  const state = snapshot(INITIAL_STREAMING_STATE, assistant());
  const next = streamReducer(state, {
    type: "deltas",
    events: [
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "Hel" },
      { type: "text_delta", contentIndex: 0, delta: "lo" },
      { type: "text_end", contentIndex: 0, content: "Hello" },
    ],
  });

  assert.deepEqual(next.streamingMessage.content, [{ type: "text", text: "Hello" }]);
});

test("builds thinking and text blocks from official assistant deltas", () => {
  let state = streamReducer(INITIAL_STREAMING_STATE, { type: "start" });
  state = snapshot(state, assistant());
  state = delta(state, { type: "thinking_start", contentIndex: 0 });
  state = delta(state, { type: "thinking_delta", contentIndex: 0, delta: "Plan" });
  state = delta(state, { type: "thinking_end", contentIndex: 0, content: "Plan." });
  state = delta(state, { type: "text_start", contentIndex: 1 });
  state = delta(state, { type: "text_delta", contentIndex: 1, delta: "Hel" });
  state = delta(state, { type: "text_delta", contentIndex: 1, delta: "lo" });
  state = delta(state, { type: "text_end", contentIndex: 1, content: "Hello" });

  assert.equal(state.isStreaming, true);
  assert.equal(state.streamingMessage.model, "claude-sonnet-4-6");
  assert.equal(state.streamingMessage.provider, "anthropic");
  assert.equal(state.streamingMessage.timestamp, 123);
  assert.equal(state.streamingMessage.content[0].type, "thinking");
  assert.equal(state.streamingMessage.content[0].thinking, "Plan.");
  assert.equal(typeof state.streamingMessage.content[0].startedAt, "number");
  assert.equal(typeof state.streamingMessage.content[0].endedAt, "number");
  assert.deepEqual(state.streamingMessage.content[1], { type: "text", text: "Hello" });
});

test("stamps a start time on snapshots that omit timestamp", () => {
  const before = Date.now();
  const state = snapshot(INITIAL_STREAMING_STATE, {
    role: "assistant",
    content: [],
    model: "claude-sonnet-4-6",
    provider: "anthropic",
  });
  const after = Date.now();
  assert.equal(typeof state.streamingMessage.timestamp, "number");
  assert.ok(state.streamingMessage.timestamp >= before);
  assert.ok(state.streamingMessage.timestamp <= after);
});

test("resume keeps the current streaming message", () => {
  const started = snapshot(INITIAL_STREAMING_STATE, assistant([{ type: "text", text: "Hello" }]));
  const resumed = streamReducer(started, { type: "resume" });
  const restarted = streamReducer(started, { type: "start" });

  assert.equal(resumed.isStreaming, true);
  assert.deepEqual(resumed.streamingMessage.content, [{ type: "text", text: "Hello" }]);
  assert.equal(restarted.streamingMessage, null);
});

test("a reconnect snapshot replaces the old partial before deltas continue", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "text", text: "stale" },
  ]));
  state = snapshot(state, assistant([
    { type: "text", text: "Hello wor" },
  ]));
  state = delta(state, { type: "text_delta", contentIndex: 0, delta: "ld" });

  assert.deepEqual(state.streamingMessage.content, [
    { type: "text", text: "Hello world" },
  ]);
});

test("text deltas update immutably so React observes each chunk", () => {
  const previous = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "text", text: "Hello" },
  ]));
  const next = delta(previous, { type: "text_delta", contentIndex: 0, delta: "!" });

  assert.notStrictEqual(next, previous);
  assert.notStrictEqual(next.streamingMessage, previous.streamingMessage);
  assert.notStrictEqual(next.streamingMessage.content, previous.streamingMessage.content);
  assert.equal(previous.streamingMessage.content[0].text, "Hello");
  assert.equal(next.streamingMessage.content[0].text, "Hello!");
});

test("shows and streams a tool call after thinking, then accepts the authoritative end", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "thinking", thinking: "I will write the file." },
  ]));

  state = delta(state, {
    type: "toolcall_start",
    contentIndex: 1,
    id: "call-1",
    toolName: "write",
  });
  assert.deepEqual(state.streamingMessage.content, [
    { type: "thinking", thinking: "I will write the file.", startedAt: 123 },
    {
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "write",
      input: {},
      rawInput: "",
    },
  ]);

  const beforeDelta = state;
  state = delta(state, {
    type: "toolcall_delta",
    contentIndex: 1,
    delta: '{"path":',
    id: "call-1",
    toolName: "write",
  });
  state = delta(state, { type: "toolcall_delta", contentIndex: 1, delta: '"/tmp/file"' });
  assert.notStrictEqual(state, beforeDelta);
  assert.equal(state.streamingMessage.content[1].rawInput, '{"path":"/tmp/file"');

  state = delta(state, {
    type: "toolcall_end",
    contentIndex: 1,
    toolCall: {
      type: "toolCall",
      id: "call-1",
      name: "write",
      arguments: { path: "/tmp/file" },
    },
  });
  assert.deepEqual(state.streamingMessage.content, [
    { type: "thinking", thinking: "I will write the file.", startedAt: 123 },
    {
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "write",
      input: { path: "/tmp/file" },
    },
  ]);
  assert.equal(Object.hasOwn(state.streamingMessage.content[1], "rawInput"), false);
});

test("restores the raw tool input from a reconnect snapshot", () => {
  const state = snapshot(INITIAL_STREAMING_STATE, assistant([{
    type: "toolCall",
    id: "call-2",
    name: "write",
    arguments: { path: "/tmp/reconnected" },
    partialJson: '{"path":"/tmp/reconnected","content":"hel',
  }]));

  assert.deepEqual(state.streamingMessage.content, [{
    type: "toolCall",
    toolCallId: "call-2",
    toolName: "write",
    input: { path: "/tmp/reconnected" },
    rawInput: '{"path":"/tmp/reconnected","content":"hel',
  }]);
});

test("ignores deltas without a baseline and unknown future deltas", () => {
  const started = streamReducer(INITIAL_STREAMING_STATE, { type: "start" });
  assert.strictEqual(
    delta(started, { type: "text_delta", contentIndex: 0, delta: "lost" }),
    started,
  );

  const withMessage = snapshot(started, assistant());
  assert.strictEqual(
    delta(withMessage, { type: "future_delta", contentIndex: 0, delta: "ignored" }),
    withMessage,
  );
});

test("normalizes tool calls in snapshots and clears on end", () => {
  const state = snapshot(INITIAL_STREAMING_STATE, assistant([{
    type: "toolCall",
    id: "call-2",
    name: "bash",
    arguments: { command: "pwd" },
  }]));
  assert.deepEqual(state.streamingMessage.content, [{
    type: "toolCall",
    toolCallId: "call-2",
    toolName: "bash",
    input: { command: "pwd" },
  }]);
  assert.strictEqual(streamReducer(state, { type: "end" }), INITIAL_STREAMING_STATE);
});

test("stamps each thinking block with its own start and end time", () => {
  const now = [1_000, 4_000, 4_000, 9_000];
  const orig = Date.now;
  Date.now = () => now.shift() ?? 9_000;
  try {
    let state = snapshot(INITIAL_STREAMING_STATE, assistant());
    state = delta(state, { type: "thinking_start", contentIndex: 0 });
    state = delta(state, { type: "thinking_end", contentIndex: 0, content: "First." });
    state = delta(state, { type: "thinking_start", contentIndex: 1 });
    state = delta(state, { type: "thinking_end", contentIndex: 1, content: "Second." });
    assert.deepEqual(state.streamingMessage.content, [
      { type: "thinking", thinking: "First.", startedAt: 1_000, endedAt: 4_000 },
      { type: "thinking", thinking: "Second.", startedAt: 4_000, endedAt: 9_000 },
    ]);
  } finally {
    Date.now = orig;
  }
});

test("copies streamed thinking timings onto the settled message", () => {
  const timed = applyThinkingTimings(
    {
      role: "assistant",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      timestamp: 123,
      content: [
        { type: "thinking", thinking: "First." },
        { type: "thinking", thinking: "Second." },
      ],
    },
    {
      role: "assistant",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      timestamp: 123,
      content: [
        { type: "thinking", thinking: "First.", startedAt: 1_000, endedAt: 4_000 },
        { type: "thinking", thinking: "Second.", startedAt: 4_000 },
      ],
    },
    9_000,
  );
  assert.deepEqual(timed.content, [
    { type: "thinking", thinking: "First.", startedAt: 1_000, endedAt: 4_000 },
    { type: "thinking", thinking: "Second.", startedAt: 4_000, endedAt: 9_000 },
  ]);
});

test("a first chunk already present in the shared partial is not duplicated (#835)", () => {
  // pi-ai documents `partial` as a shared live response-so-far object, so the
  // message_start snapshot can already carry the chunk the following delta
  // delivers again. Without a reset on *_start the block renders that chunk
  // twice until the authoritative *_end replaces it.
  let state = snapshot(INITIAL_STREAMING_STATE, {
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    timestamp: 123,
  });
  state = delta(state, { type: "text_start", contentIndex: 0 });
  state = delta(state, { type: "text_delta", contentIndex: 0, delta: "Hello" });
  state = delta(state, { type: "text_delta", contentIndex: 0, delta: " world" });

  assert.deepEqual(state.streamingMessage.content, [{ type: "text", text: "Hello world" }]);

  // The same leak applies to thinking blocks and to streamed tool arguments.
  let thinking = snapshot(INITIAL_STREAMING_STATE, {
    role: "assistant",
    content: [{ type: "thinking", thinking: "Plan" }],
    timestamp: 123,
  });
  thinking = delta(thinking, { type: "thinking_start", contentIndex: 0 });
  thinking = delta(thinking, { type: "thinking_delta", contentIndex: 0, delta: "Plan" });
  assert.equal(thinking.streamingMessage.content[0].thinking, "Plan");

  let tool = snapshot(INITIAL_STREAMING_STATE, {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "t1", toolName: "bash", input: {}, rawInput: '{"c' }],
    timestamp: 123,
  });
  tool = delta(tool, { type: "toolcall_start", contentIndex: 0, id: "t1", toolName: "bash" });
  tool = delta(tool, { type: "toolcall_delta", contentIndex: 0, delta: '{"c' });
  tool = delta(tool, { type: "toolcall_delta", contentIndex: 0, delta: 'md":"ls"}' });
  assert.equal(tool.streamingMessage.content[0].rawInput, '{"cmd":"ls"}');
});
