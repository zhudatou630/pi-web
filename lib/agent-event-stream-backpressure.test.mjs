import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createAgentEventStream, getLiveAgentEventStreamCount } = await createJiti(import.meta.url).import("./agent-event-stream.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const decode = (chunk) => JSON.parse(new TextDecoder().decode(chunk.value).slice(6));

function session() {
  let listener;
  let unsubscribed = 0;
  return {
    isStreaming: true,
    streamingMessage: undefined,
    runningTools: [],
    onEvent(fn, keepAlive) {
      assert.equal(keepAlive, true);
      listener = fn;
      return () => { unsubscribed += 1; };
    },
    emit: (event) => listener(event),
    get unsubscribed() { return unsubscribed; },
  };
}

function limit(t, value) {
  const previous = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(value);
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previous;
  });
}

test("slow SSE client drops only reparable deltas, retaining block starts and authoritative ends", async (t) => {
  limit(t, 2 * 1024 * 1024);
  const current = session();
  const stream = createAgentEventStream(new Request("http://localhost/events"), "slow", Promise.resolve(current));
  const reader = stream.getReader();
  t.after(() => reader.cancel());
  await reader.read(); // transport
  await reader.read(); // handshake
  current.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  for (let i = 0; i < 100; i += 1) {
    current.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(100_000), contentIndex: 0 } });
    current.emit({ type: "tool_execution_update", partialResult: { content: [{ type: "text", text: "x".repeat(100_000) }] } });
  }
  current.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "authoritative", contentIndex: 0 } });
  current.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "authoritative" }] } });
  current.emit({ type: "prompt_done" });
  const events = [];
  while (events.at(-1)?.type !== "prompt_done") events.push(decode(await reader.read()));
  assert.ok(events.length < 15);
  assert.equal(events[0].assistantMessageEvent.type, "text_start");
  assert.equal(events.at(-3).assistantMessageEvent.type, "text_end");
  assert.equal(events.at(-3).assistantMessageEvent.content, "authoritative");
  assert.equal(events.at(-2).type, "message_end");
});

test("unrecoverable backlog is counted in UTF-8 bytes, error-closed, and resnapshotted on reconnect", async (t) => {
  limit(t, 64 * 1024);
  t.mock.method(console, "warn", () => {});
  const before = getLiveAgentEventStreamCount();
  const current = session();
  const stream = createAgentEventStream(new Request("http://localhost/events"), "slow", Promise.resolve(current));
  const reader = stream.getReader();
  // Error instead of close must discard even chunks queued before the overflow.
  const closed = assert.rejects(reader.closed, /client backlog exceeded/);
  await nextTurn();
  current.emit({ type: "message_start", message: { role: "user", content: "x".repeat(40_000) } });
  current.emit({ type: "message_end", message: { role: "user", content: "界".repeat(12_000) } });
  await closed;
  await assert.rejects(reader.read(), /client backlog exceeded/);
  assert.equal(current.unsubscribed, 1);
  assert.equal(getLiveAgentEventStreamCount(), before);

  current.streamingMessage = { role: "assistant", content: [{ type: "text", text: "recovered" }] };
  const retry = createAgentEventStream(new Request("http://localhost/events"), "slow", Promise.resolve(current)).getReader();
  t.after(() => retry.cancel());
  await retry.read();
  assert.equal(decode(await retry.read()).type, "connected");
  assert.deepEqual(decode(await retry.read()), { type: "message_start", message: current.streamingMessage });
});
