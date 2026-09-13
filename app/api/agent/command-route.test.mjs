import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./[id]/route.ts");

test("queued subagent sessions reject direct commands", async (t) => {
  const previousRuns = globalThis.__piSubagentRuns;
  const id = "queued-subagent-command";
  let cancelled = 0;
  const stored = {
    run: { status: "queued" },
    abortRequested: false,
    cancelQueued: () => { cancelled += 1; return true; },
  };
  globalThis.__piSubagentRuns = new Map([[id, stored]]);
  t.after(() => { globalThis.__piSubagentRuns = previousRuns; });

  const response = await POST(new Request(`http://localhost/api/agent/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "prompt", message: "bypass queue" }),
  }), { params: Promise.resolve({ id }) });

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "Subagent is queued");

  const stateResponse = await GET(new Request(`http://localhost/api/agent/${id}`), { params: Promise.resolve({ id }) });
  assert.deepEqual(await stateResponse.json(), {
    running: true,
    state: { isStreaming: false, isPromptRunning: true },
  });

  const abortResponse = await POST(new Request(`http://localhost/api/agent/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "abort" }),
  }), { params: Promise.resolve({ id }) });
  assert.equal(abortResponse.status, 200);
  assert.equal(stored.abortRequested, true);
  assert.equal(cancelled, 1);
});

test("aborting an already terminal subagent is idempotent", async (t) => {
  const previousRuns = globalThis.__piSubagentRuns;
  const id = "aborted-subagent-command";
  globalThis.__piSubagentRuns = new Map([[id, {
    abortRequested: true,
    run: { sessionId: id, status: "aborted" },
  }]]);
  t.after(() => { globalThis.__piSubagentRuns = previousRuns; });

  const response = await POST(new Request(`http://localhost/api/agent/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "abort" }),
  }), { params: Promise.resolve({ id }) });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, data: null });
});

test("direct prompts to a running subagent are routed as steering", async (t) => {
  const previousRuns = globalThis.__piSubagentRuns;
  const previousRegistry = globalThis.__piSessions;
  const id = "running-subagent-command";
  const steered = [];
  let aborted = 0;
  const stored = { abortRequested: false, run: {
    sessionId: id,
    sessionPath: `/tmp/${id}.jsonl`,
    parentSessionId: "parent",
    parentToolCallId: "tool-call",
    profile: "general-purpose",
    description: "Test child input",
    task: "Test",
    runInBackground: true,
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
  } };
  globalThis.__piSubagentRuns = new Map([[id, stored]]);
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    inner: {
      steer: async (message) => { steered.push(message); },
      abort: async () => { aborted += 1; },
    },
  }]]);
  t.after(() => {
    globalThis.__piSubagentRuns = previousRuns;
    globalThis.__piSessions = previousRegistry;
  });

  const response = await POST(new Request(`http://localhost/api/agent/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "prompt", message: "  focus on the error  " }),
  }), { params: Promise.resolve({ id }) });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.subagentAction, "steered");
  assert.deepEqual(steered, ["focus on the error"]);

  const imageResponse = await POST(new Request(`http://localhost/api/agent/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "prompt", message: "inspect", images: [{ type: "image", data: "abc", mimeType: "image/png" }] }),
  }), { params: Promise.resolve({ id }) });
  const imageBody = await imageResponse.json();
  assert.equal(imageResponse.status, 400);
  assert.equal(imageBody.code, "prompt_rejected");
  assert.equal(imageBody.accepted, false);

  const abortResponse = await POST(new Request(`http://localhost/api/agent/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "abort" }),
  }), { params: Promise.resolve({ id }) });
  assert.equal(abortResponse.status, 200);
  assert.equal(stored.abortRequested, true);
  assert.equal(aborted, 1);
});