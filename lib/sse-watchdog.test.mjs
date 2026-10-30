import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { AgentEventConnection } = await jiti.import("./agent-event-connection.ts");
const { FileWatchEventSource } = await jiti.import("./file-watch-client.ts");

test("75s of silence replaces a ready agent stream through its normal handshake", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sources = [], events = [];
  const connection = new AgentEventConnection({
    createSource() {
      const source = { readyState: 1, close() { this.readyState = 2; }, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
    onEvent: (event) => events.push(event.type),
    shouldMaintain: () => true,
    readinessTimeoutMs: 10_000,
    reconnectDelayMs: 1_000,
  });
  const data = (event) => sources.at(-1).onmessage({ data: JSON.stringify(event) });
  const ready = connection.ensureConnected("test");
  data({ type: "connected" });
  await ready;
  t.mock.timers.tick(30_000);
  data({ type: "heartbeat" });
  assert.deepEqual(events, ["connected"], "heartbeat does not reach state/rendering");
  t.mock.timers.tick(74_999);
  assert.equal(sources[0].readyState, 1);
  t.mock.timers.tick(1);
  assert.equal(sources[0].readyState, 2);
  t.mock.timers.tick(1_000);
  assert.equal(sources.length, 2);
  data({ type: "connected" });
  await Promise.resolve();
  assert.deepEqual(events, ["connected", "connected"], "existing reconcile receives the new handshake");
  connection.close();
  t.mock.timers.tick(100_000);
  assert.equal(sources.length, 2, "close cancels the watchdog");
});

test("file watches forward data, ignore heartbeat, replace silent sources and stop on close", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sources = [];
  const original = globalThis.EventSource;
  t.after(() => { if (original) globalThis.EventSource = original; else delete globalThis.EventSource; });
  globalThis.EventSource = class extends EventTarget {
    closed = false;
    constructor() { super(); sources.push(this); }
    close() { this.closed = true; }
  };
  const watch = new FileWatchEventSource("/watch");
  const events = [];
  for (const name of ["connected", "change", "heartbeat", "error"]) watch.addEventListener(name, () => events.push(name));
  sources[0].dispatchEvent(new MessageEvent("connected", { data: "{}" }));
  t.mock.timers.tick(30_000);
  sources[0].dispatchEvent(new MessageEvent("heartbeat", { data: "{}" }));
  t.mock.timers.tick(74_999);
  assert.equal(sources.length, 1);
  t.mock.timers.tick(1);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].closed, true);
  sources[1].dispatchEvent(new MessageEvent("change", { data: "{}" }));
  assert.deepEqual(events, ["connected", "error", "change"]);
  watch.close();
  t.mock.timers.tick(100_000);
  assert.equal(sources.length, 2);
});
