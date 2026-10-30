import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { createPageEventSource, getPageDebugSnapshot, pageDebugFetch } = await createJiti(import.meta.url).import("./page-debug.ts");

test("all stream kinds carry one page id; data, reconnects and close are observed without extra requests", async (t) => {
  const key = Symbol.for("@calmabacus/pi-web/page-debug/v1");
  const original = globalThis.EventSource;
  t.after(() => { delete globalThis[key]; if (original) globalThis.EventSource = original; else delete globalThis.EventSource; });
  const sources = [];
  globalThis.EventSource = class extends EventTarget {
    readyState = 0;
    constructor(url) { super(); this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
  };
  const agent = createPageEventSource("/agent/events", "agent", "session");
  const terminal = createPageEventSource("/terminal/events?after=42", "terminal", "terminal");
  const file = createPageEventSource("/files/private/path?type=watch", "file-watch");
  const state = getPageDebugSnapshot();
  for (const source of sources) assert.equal(new URL(source.url, "http://localhost").searchParams.get("pageId"), state.id);
  assert.equal(new URL(terminal.url, "http://localhost").searchParams.get("after"), "42");
  agent.readyState = 1;
  agent.dispatchEvent(new Event("open"));
  agent.dispatchEvent(new MessageEvent("message", { data: "heartbeat" }));
  agent.dispatchEvent(new Event("open"));
  assert.equal(getPageDebugSnapshot().streams[0].reconnects, 1);
  assert.equal(typeof getPageDebugSnapshot().streams[0].lastDataAt, "number");
  agent.close();
  const replacement = createPageEventSource("/agent/events", "agent", "session");
  assert.equal(getPageDebugSnapshot().streams.at(-1).reconnects, 2);
  assert.doesNotMatch(JSON.stringify(getPageDebugSnapshot()), /private\/path/);
  replacement.close(); terminal.close(); file.close();
  assert.equal(getPageDebugSnapshot().streams.length, 0);
  assert.equal(sources.length, 4);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("", { status: calls === 1 ? 200 : 503 }); });
  await pageDebugFetch("running", "/running");
  await pageDebugFetch("lease", "/lease");
  assert.equal(calls, 2, "observation does not add requests");
  assert.equal(getPageDebugSnapshot().requests.running.ok, true);
  assert.equal(getPageDebugSnapshot().requests.lease.failures, 1);
  const abort = new AbortController();
  t.mock.method(globalThis, "fetch", async () => { abort.abort(); throw new Error("cancelled"); });
  await assert.rejects(pageDebugFetch("lease", "/lease", { signal: abort.signal }));
  assert.equal(getPageDebugSnapshot().requests.lease.failures, 1, "intentional aborts are not network failures");
});
