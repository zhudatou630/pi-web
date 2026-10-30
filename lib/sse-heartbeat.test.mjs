import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { createAgentEventStream } = await jiti.import("./agent-event-stream.ts");
const { GET } = await jiti.import("../app/api/terminal/[id]/events/route.ts");
const { readSseConnections } = await jiti.import("./sse-connections.ts");
const text = async (reader) => new TextDecoder().decode((await reader.read()).value);

test("agent heartbeat is data and abort removes its page connection", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const abort = new AbortController();
  const reader = createAgentEventStream(new Request("http://localhost/events?pageId=agent-page", { signal: abort.signal }), "agent", Promise.resolve({
    isStreaming: false, streamingMessage: null, runningTools: [], onEvent: () => () => {},
  })).getReader();
  await text(reader); // Flush comment, not the readiness handshake.
  assert.match(await text(reader), /"type":"connected"/);
  t.mock.timers.tick(30_000);
  assert.equal(await text(reader), 'data: {"type":"heartbeat"}\n\n');
  assert.equal(readSseConnections()[0].pageId, "agent-page");
  abort.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(readSseConnections().length, 0);
});

test("terminal heartbeat is data and abort releases its listener and page connection", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const old = globalThis.__piWebTerminals;
  const record = { listeners: new Set(), offset: 0, backlog: "", exited: false, cleanupTimer: null };
  globalThis.__piWebTerminals = new Map([["terminal", record]]);
  t.after(() => { clearTimeout(record.cleanupTimer); globalThis.__piWebTerminals = old; });
  const abort = new AbortController();
  const response = await GET(new Request("http://localhost/events?pageId=terminal-page", { signal: abort.signal }), { params: Promise.resolve({ id: "terminal" }) });
  const reader = response.body.getReader();
  await text(reader); // Flush comment.
  assert.match(await text(reader), /"type":"output"/);
  t.mock.timers.tick(30_000);
  assert.equal(await text(reader), 'event: heartbeat\ndata: {}\n\n');
  assert.equal(record.listeners.size, 1);
  assert.equal(readSseConnections()[0].kind, "terminal");
  abort.abort();
  assert.equal(record.listeners.size, 0);
  assert.equal(readSseConnections().length, 0);
  assert.equal((await reader.read()).done, true);
});
