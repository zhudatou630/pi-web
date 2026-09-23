import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  createAgentEventStream,
  closeAllAgentEventStreams,
  getLiveAgentEventStreamCount,
  resetAgentEventStreamShutdownForTests,
} = await jiti.import("./agent-event-stream.ts");

function fakeSession() {
  const listeners = new Set();
  return {
    isStreaming: false,
    streamingMessage: undefined,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onClose() { return () => {}; },
  };
}

test("shutdown closes live streams so Next's drain can finish", async () => {
  const before = getLiveAgentEventStreamCount();
  const streams = [1, 2, 3].map((n) => createAgentEventStream(
    { signal: new AbortController().signal },
    `s${n}`,
    Promise.resolve(fakeSession()),
  ));
  // ReadableStream constructors may defer start(); give them a turn.
  await new Promise((r) => setImmediate(r));

  assert.equal(getLiveAgentEventStreamCount() - before, 3, "every stream must register");

  const closed = closeAllAgentEventStreams();
  assert.ok(closed >= 3, "shutdown must close the live streams");
  assert.equal(getLiveAgentEventStreamCount(), 0, "the registry must be drained");

  // Cancelling an already-closed stream must stay a no-op, not throw.
  closeAllAgentEventStreams();
  await Promise.all(streams.map((s) => s.cancel().catch(() => {})));
});

test("a cancelled stream leaves the registry", async () => {
  // `closeAllAgentEventStreams` marks the process as shutting down for the rest of
  // its life (that is the point), so re-open it for this test.
  resetAgentEventStreamShutdownForTests();
  const before = getLiveAgentEventStreamCount();
  const stream = createAgentEventStream(
    { signal: new AbortController().signal },
    "solo",
    Promise.resolve(fakeSession()),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(getLiveAgentEventStreamCount(), before + 1);

  await stream.cancel();
  assert.equal(getLiveAgentEventStreamCount(), before, "a cancelled stream must unregister");
});

test("a stream that registers after the shutdown sweep closes instead of lingering", async () => {
  closeAllAgentEventStreams();
  const stream = createAgentEventStream(
    { signal: new AbortController().signal },
    "late",
    Promise.resolve(fakeSession()),
  );
  await new Promise((r) => setImmediate(r));
  // Next's drain would otherwise wait forever on a connection nobody closes.
  assert.equal(getLiveAgentEventStreamCount(), 0, "a late stream must not be registered");
  await stream.cancel().catch(() => {});
  resetAgentEventStreamShutdownForTests();
});
