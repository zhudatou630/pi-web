import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { POST } = await jiti.import("../app/api/agent/[id]/lease/route.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function wrapper(t) {
  const inner = {
    sessionId: "lease-test", isBashRunning: false, isStreaming: false, isCompacting: false,
    extensionRunner: {}, agent: { state: {} }, subscribe: () => () => {}, dispose() {},
  };
  const session = new AgentSessionWrapper(inner);
  t.after(() => session.destroy());
  session.start();
  return session;
}

test("a renewal resets the one idle clock; expiry is one timeout after the last renewal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = wrapper(t);
  t.mock.timers.tick(500_000);
  assert.equal(session.renewIdleTimer(), true);
  t.mock.timers.tick(599_999);
  await nextTurn();
  assert.equal(session.isAlive(), true);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(session.isAlive(), false);
  assert.equal(session.renewIdleTimer(), false, "cannot revive a closing/disposed wrapper");
});

test("renewals cannot move Stop's forced deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = wrapper(t);
  session.inner.isStreaming = true;
  session.forceShutdownOnIdle = true;
  session.resetIdleTimer();
  const timer = session.idleTimer;
  t.mock.timers.tick(300_000);
  assert.equal(session.renewIdleTimer(), false);
  assert.equal(session.idleTimer, timer);
  t.mock.timers.tick(300_000);
  await nextTurn();
  assert.equal(session.isAlive(), false);
});

test("lease route only renews an existing wrapper, never creates a runtime or lease record", async (t) => {
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map();
  t.after(() => { globalThis.__piSessions = previous; });
  const renew = (id) => POST(new Request(`http://localhost/api/agent/${id}/lease`, { method: "POST" }), { params: Promise.resolve({ id }) });
  assert.equal((await (await renew("missing")).json()).renewed, 0);
  assert.equal(globalThis.__piSessions.size, 0);
  let calls = 0;
  globalThis.__piSessions.set("live", { isAlive: () => true, resetIdleTimer() { calls++; } });
  assert.equal((await (await renew("live")).json()).renewed, 1);
  assert.equal(calls, 1);
  assert.equal(globalThis[Symbol.for("@calmabacus/pi-web/session-liveness-leases/v1")], undefined);
});
