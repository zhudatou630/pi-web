import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createJiti } from "jiti";

const { CacheKeepalive, CACHE_KEEPALIVE_MAX_MS, CACHE_KEEPALIVE_REFRESH_MS, CACHE_KEEPALIVE_TYPE, readCacheKeepalive } =
  await createJiti(import.meta.url).import("./cache-keepalive.ts");

const MODEL = { api: "anthropic-messages", provider: "claude", id: "opus", compat: { forceAdaptiveThinking: true } };

function setup({ enabled = true, cacheRead = 1000, longByDefault = false } = {}) {
  let clock = 0;
  const calls = [];
  const entries = enabled ? [{ type: "custom", customType: CACHE_KEEPALIVE_TYPE, data: { version: 1, enabled: true } }] : [];
  const usage = [];
  const agent = {
    state: { model: MODEL, messages: [{ role: "user" }] },
    streamFunction: async (model, context, options) => {
      calls.push(options);
      return { result: async () => ({ stopReason: "length", provider: "claude", model: "opus", usage: { cacheRead } }) };
    },
  };
  const sessionManager = {
    getSessionId: () => "s",
    getEntries: () => entries,
    appendCustomEntry: (customType, data) => { entries.push({ type: "custom", customType, data }); return "e"; },
    appendUsage: (kind, provider, model, value) => { usage.push({ kind, value }); },
  };
  const keepalive = new CacheKeepalive({ agent, sessionManager }, () => clock, () => longByDefault);
  return {
    keepalive, agent, calls, usage, entries,
    advance(ms) { clock += ms; mock.timers.tick(ms); },
    send: (options = { sessionId: "s" }, model = MODEL) => agent.streamFunction(model, {}, options),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("only this session's own Anthropic requests get the 1h TTL, and only while on", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { keepalive, calls, send } = setup();

  await send();
  assert.equal(calls.pop().cacheRetention, "long");
  assert.ok(keepalive.isScheduled);

  await send({ sessionId: "parent" });
  assert.equal(calls.pop().cacheRetention, undefined, "side chat sends the parent's id");
  await send({ sessionId: "s", cacheRetention: "none" });
  assert.equal(calls.pop().cacheRetention, "none", "explicit retention (compaction) wins");
  await send({ sessionId: "s" }, { ...MODEL, api: "openai-responses" });
  assert.equal(calls.pop().cacheRetention, undefined);

  keepalive.setEnabled(false);
  assert.equal(keepalive.isScheduled, false);
  await send();
  assert.equal(calls.pop().cacheRetention, undefined);
});

test("refreshes before the hour runs out, records usage, and stops after 8 h", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { keepalive, calls, usage, send, advance } = setup();

  await send();
  calls.length = 0;
  assert.equal(keepalive.status().nextRefreshAt, CACHE_KEEPALIVE_REFRESH_MS);

  advance(CACHE_KEEPALIVE_REFRESH_MS);
  await flush();
  const { signal, ...replay } = calls.pop();
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(replay, { sessionId: "s", cacheRetention: "long", maxTokens: 1, maxRetries: 0 });
  assert.equal(usage.length, 1);
  assert.equal(usage[0].kind, "pi-web:cache-keepalive");

  const refreshes = Math.floor(CACHE_KEEPALIVE_MAX_MS / CACHE_KEEPALIVE_REFRESH_MS);
  for (let i = 1; i < refreshes + 2; i += 1) {
    advance(CACHE_KEEPALIVE_REFRESH_MS);
    await flush();
  }
  assert.equal(usage.length, refreshes, "no refresh past 10 h after the last real request");
  assert.equal(keepalive.isScheduled, false);
});

test("stops when the entry was lost, the context changed, or the request cannot be replayed", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const lost = setup({ cacheRead: 0 });
  await lost.send();
  lost.advance(CACHE_KEEPALIVE_REFRESH_MS);
  await flush();
  assert.equal(lost.usage.length, 1, "the miss is still billed");
  assert.equal(lost.keepalive.isScheduled, false);

  const changed = setup();
  await changed.send();
  changed.agent.state.messages = [{ role: "user" }]; // navigate_tree / compaction: new objects
  changed.advance(CACHE_KEEPALIVE_REFRESH_MS);
  await flush();
  assert.equal(changed.usage.length, 0);
  assert.equal(changed.keepalive.isScheduled, false);

  const budget = setup();
  await budget.send({ sessionId: "s", reasoning: "high" }, { ...MODEL, compat: {} });
  assert.equal(budget.keepalive.isScheduled, false);
});

test("the switch persists as the newest session entry", () => {
  const { keepalive, entries } = setup({ enabled: false });
  assert.equal(readCacheKeepalive(entries), false);
  keepalive.setEnabled(true);
  assert.equal(readCacheKeepalive(entries), true);
  keepalive.setEnabled(false);
  assert.equal(readCacheKeepalive(entries), false);
  assert.equal(entries.length, 2);
});

test("turning on keeps the newest request's 1h entry warm while a refresh can still reach it", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const warm = setup({ enabled: false, longByDefault: true });
  await warm.send();
  assert.equal(warm.calls.pop().cacheRetention, undefined, "off: the global TTL wrapper decides");
  warm.advance(30 * 60_000);
  warm.keepalive.setEnabled(true);
  assert.equal(warm.keepalive.status().nextRefreshAt, CACHE_KEEPALIVE_REFRESH_MS, "due from the original request");
  warm.advance(CACHE_KEEPALIVE_REFRESH_MS - 30 * 60_000);
  await flush();
  assert.equal(warm.usage.length, 1);
  assert.equal(warm.calls.pop().cacheRetention, "long");

  const late = setup({ enabled: false, longByDefault: true });
  await late.send();
  late.advance(58 * 60_000);
  late.keepalive.setEnabled(true);
  assert.equal(late.keepalive.isScheduled, false);

  const short = setup({ enabled: false });
  await short.send();
  short.keepalive.setEnabled(true);
  assert.equal(short.keepalive.isScheduled, false, "a 5m entry is not continued");

  const toggled = setup({ longByDefault: false });
  await toggled.send();
  toggled.keepalive.setEnabled(false);
  toggled.keepalive.setEnabled(true);
  assert.ok(toggled.keepalive.isScheduled, "off and on again resumes its own 1h entry");
  toggled.advance(CACHE_KEEPALIVE_REFRESH_MS);
  await flush();
  assert.equal(toggled.usage.length, 1, "the resumed run has a fresh signal");
});

test("refreshes fold into one display-only transcript line per idle stretch", async () => {
  const { buildSessionContext } = await createJiti(import.meta.url).import("./session-reader.ts");
  const { CACHE_WARM_MESSAGE_TYPE } = await createJiti(import.meta.url).import("./cache-keepalive.ts");
  const cost = (total) => ({ input: 0, output: 0, cacheRead: total, cacheWrite: 0, total });
  let parentId = null;
  let n = 0;
  const entry = (fields) => {
    const id = `e${n++}`;
    const value = { id, parentId, timestamp: new Date(Date.UTC(2026, 0, 1, 12, n)).toISOString(), ...fields };
    parentId = id;
    return value;
  };
  const user = () => entry({ type: "message", message: { role: "user", content: "hi", timestamp: n } });
  const reply = () => entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: n } });
  const warm = (cacheRead, total) => entry({ type: "usage", kind: "pi-web:cache-keepalive", provider: "claude", model: "opus", usage: { input: 0, output: 1, cacheRead, cacheWrite: 0, totalTokens: cacheRead + 1, cost: cost(total) } });
  const piWarm = () => entry({ type: "usage", kind: "cache_warm", provider: "claude", model: "opus", usage: { input: 0, output: 1, cacheRead: 9, cacheWrite: 0, totalTokens: 10, cost: cost(0.01) } });
  const entries = [user(), reply(), warm(100, 0.02), warm(100, 0.03), user(), piWarm(), reply(), warm(0, 0.5)];

  const context = buildSessionContext(entries, parentId);
  assert.deepEqual(context.messages.map((message) => message.customType ?? message.role), ["user", "assistant", CACHE_WARM_MESSAGE_TYPE, "user", "assistant", CACHE_WARM_MESSAGE_TYPE]);
  assert.deepEqual(context.entryIds, ["e0", "e1", "e3", "e4", "e6", "e7"], "the line points at its newest refresh; pi's own cache_warm stays hidden");
  assert.deepEqual(context.messages[2].details, { count: 2, cost: 0.05, missed: false });
  assert.deepEqual(context.messages[5].details, { count: 1, cost: 0.5, missed: true });
  assert.equal(context.messages[2].display, true);
});

test("a recorded refresh notifies open views", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { keepalive, send, advance } = setup();
  let refreshed = 0;
  keepalive.onRefreshed = () => { refreshed += 1; };
  await send();
  advance(CACHE_KEEPALIVE_REFRESH_MS);
  await flush();
  assert.equal(refreshed, 1);
});
