import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST: forkSession } = await jiti.import("./[id]/fork/route.ts");
const { GET: getSessionList } = await jiti.import("./route.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");

test("fork route copies a saved session into a linked session and refuses an unknown id", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-fork-route-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();
  const createdIds = [];
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const id of createdIds) invalidateSessionPathCache(id);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });

  const manager = SessionManager.create(dir);
  manager.appendMessage({ role: "user", content: "route fixture", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "route answer" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sourceId = manager.getSessionId();
  createdIds.push(sourceId);
  invalidateSessionListCache();

  const missing = await forkSession(
    new Request("http://localhost/api/sessions/missing/fork", { method: "POST", body: "{}" }),
    { params: Promise.resolve({ id: "missing" }) },
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "not_found");

  const response = await forkSession(
    new Request(`http://localhost/api/sessions/${sourceId}/fork`, {
      method: "POST",
      body: JSON.stringify({ leafId: manager.getLeafId() }),
    }),
    { params: Promise.resolve({ id: sourceId }) },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.sessionId, "string");
  assert.notEqual(body.sessionId, sourceId);
  createdIds.push(body.sessionId);

  const list = await getSessionList(new Request("http://localhost/api/sessions"));
  assert.equal(list.status, 200);
  const sessions = (await list.json()).sessions;
  const forked = sessions.find((session) => session.id === body.sessionId);
  assert.equal(forked?.relation?.kind, "fork");
  assert.equal(forked?.relation?.originSessionId, sourceId);
  assert.equal(forked?.parentSessionId, sourceId);
  assert.equal(sessions.find((session) => session.id === sourceId)?.relation, undefined);
});
