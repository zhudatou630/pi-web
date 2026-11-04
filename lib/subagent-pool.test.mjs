import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  classifySubagentPoolSwitch,
  installSubagentPoolFailover,
  isSubagentPoolCooling,
  isSubagentPoolSwitchableError,
  markSubagentPoolCooldown,
  pickNextPoolMember,
  profilePool,
  resetSubagentPoolCooldownForTests,
  selectPoolStart,
  serializeProfilePool,
  SUBAGENT_POOL_SWITCH_TYPE,
  uniqueModelRefs,
} = await jiti.import("./subagent-pool.ts");
const { retryStreamDrops } = await jiti.import("./retry-stream-drops.ts");

const A = { provider: "anthropic", id: "claude-sonnet-4-6" };
const B = { provider: "my-anthropic-2", id: "claude-sonnet-4-6" };
const C = { provider: "openai", id: "gpt-5.4" };

function errorMessage(text, stopReason = "error") {
  return { role: "assistant", stopReason, errorMessage: text, content: [] };
}

function host(options = {}) {
  const calls = { setModel: [], persist: [], prepare: 0, omit: 0, entries: [], emit: [] };
  const session = {
    model: options.model ?? A,
    _retryAttempt: 0,
    _agentRunAbortRequested: false,
    _isRetryableError: options.isRetryable ?? function isRetryable(message) {
      return isRetryableAssistantError(message);
    },
    _prepareRetry: options.prepare ?? async function prepare() {
      calls.prepare += 1;
      const settings = session.settingsManager.getRetrySettings();
      session._retryAttempt += 1;
      if (session._retryAttempt > settings.maxRetries) {
        session._retryAttempt -= 1;
        return false;
      }
      return true;
    },
    _omitRecoveryAttempt() {
      calls.omit += 1;
    },
    _emit(event) {
      calls.emit.push(event);
    },
    async setModel(model, opts) {
      calls.setModel.push(model);
      calls.persist.push(opts?.persist);
      session.model = model;
    },
    settingsManager: {
      getRetrySettings: () => options.retry ?? { enabled: true, maxRetries: 3 },
    },
    sessionManager: {
      appendCustomEntry(type, data) {
        calls.entries.push({ type, data });
      },
    },
  };
  if (options.missingMethods) {
    delete session._isRetryableError;
    delete session._prepareRetry;
  }
  if (options.noSetModel) delete session.setModel;
  if (options.noOmit) delete session._omitRecoveryAttempt;
  return { session, calls };
}

test("profilePool and serializeProfilePool keep scalar model files stable", () => {
  assert.deepEqual(profilePool({ model: "anthropic/claude-sonnet-4-6" }), ["anthropic/claude-sonnet-4-6"]);
  assert.deepEqual(serializeProfilePool({ model: "anthropic/claude-sonnet-4-6" }), {
    model: "anthropic/claude-sonnet-4-6",
  });
  assert.equal("models" in serializeProfilePool({ model: "a/b" }), false);
  assert.deepEqual(serializeProfilePool({}), {});
  assert.deepEqual(profilePool({}), []);
});

test("serializeProfilePool writes model === models[0], dedupes, and prepends a mismatched model", () => {
  assert.deepEqual(
    serializeProfilePool({
      models: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
    }),
    {
      model: "anthropic/claude-sonnet-4-6",
      models: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
    },
  );
  assert.deepEqual(
    serializeProfilePool({
      model: "openai/gpt-5.4",
      models: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
    }),
    {
      model: "openai/gpt-5.4",
      models: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
    },
  );
  assert.deepEqual(uniqueModelRefs([" a ", "", "a", "b"]), ["a", "b"]);
});

test("the switch decision matrix cuts only upstream failures while a member remains", () => {
  const remaining = { hasRemainingMember: true };
  const none = { hasRemainingMember: false };

  assert.equal(classifySubagentPoolSwitch(errorMessage("429 rate limit")), "transient");
  assert.equal(classifySubagentPoolSwitch(errorMessage("server_error 503")), "transient");
  assert.equal(classifySubagentPoolSwitch(errorMessage("request timeout")), "timeout");
  assert.equal(classifySubagentPoolSwitch(errorMessage("fetch failed")), "transient");
  assert.equal(isSubagentPoolSwitchableError(errorMessage("429 rate limit"), remaining), true);

  assert.equal(classifySubagentPoolSwitch(errorMessage("401 Unauthorized")), "auth");
  assert.equal(classifySubagentPoolSwitch(errorMessage("403 forbidden")), "auth");
  assert.equal(classifySubagentPoolSwitch(errorMessage("invalid_api_key")), "auth");
  assert.equal(classifySubagentPoolSwitch(errorMessage("No API key for anthropic/claude")), "auth");
  assert.equal(isSubagentPoolSwitchableError(errorMessage("401 Unauthorized"), remaining), true);
  assert.equal(isSubagentPoolSwitchableError(errorMessage("401 Unauthorized"), none), false);
  assert.equal(isRetryableAssistantError(errorMessage("401 Unauthorized")), false);

  assert.equal(classifySubagentPoolSwitch(errorMessage("insufficient_quota: quota exceeded")), "quota");
  assert.equal(isSubagentPoolSwitchableError(errorMessage("insufficient_quota: quota exceeded"), remaining), true);
  assert.equal(isRetryableAssistantError(errorMessage("insufficient_quota: quota exceeded")), false);

  assert.equal(classifySubagentPoolSwitch(errorMessage("This operation was aborted.")), null);
  assert.equal(classifySubagentPoolSwitch(errorMessage("Upstream HTTP/2 stream failed", "aborted")), null);
  assert.equal(classifySubagentPoolSwitch(errorMessage("prompt is too long: 213462 tokens > 200000 maximum")), null);
  assert.equal(classifySubagentPoolSwitch({ stopReason: "length", errorMessage: "max tokens", content: [] }), null);
  assert.equal(classifySubagentPoolSwitch({ stopReason: "stop", content: [{ type: "toolCall", id: "t", name: "bash" }] }), null);
  assert.equal(isSubagentPoolSwitchableError(errorMessage("This operation was aborted."), remaining), false);
});

test("the SDK still exposes _isRetryableError and _prepareRetry for the pool patch", () => {
  assert.equal(typeof AgentSession.prototype._isRetryableError, "function");
  assert.equal(typeof AgentSession.prototype._prepareRetry, "function");
});

test("install is a no-op when the pool has fewer than two members or private methods are missing", async () => {
  const single = host();
  const originalRetry = single.session._isRetryableError;
  const originalPrepare = single.session._prepareRetry;
  const disposeSingle = installSubagentPoolFailover(single.session, [A]);
  assert.equal(single.session._isRetryableError, originalRetry);
  assert.equal(single.session._prepareRetry, originalPrepare);
  disposeSingle();

  const missing = host({ missingMethods: true });
  const disposeMissing = installSubagentPoolFailover(missing.session, [A, B]);
  assert.equal(missing.session._isRetryableError, undefined);
  await missing.session.setModel?.(B, { persist: true });
  assert.deepEqual(missing.calls.persist, [true]);
  disposeMissing();
});

test("transient errors exhaust same-model retries then setModel with persist false", async () => {
  resetSubagentPoolCooldownForTests();
  const { session, calls } = host();
  installSubagentPoolFailover(session, [A, B]);
  const message = errorMessage("429 too many requests");
  assert.equal(session._isRetryableError(message), true);
  assert.equal(await session._prepareRetry(message), true);
  assert.equal(await session._prepareRetry(message), true);
  assert.equal(await session._prepareRetry(message), true);
  assert.equal(calls.setModel.length, 0);
  assert.equal(await session._prepareRetry(message), true);
  assert.equal(calls.setModel.length, 1);
  assert.equal(calls.setModel[0], B);
  assert.deepEqual(calls.persist, [false]);
  assert.equal(session._retryAttempt, 0);
  assert.equal(calls.omit, 1);
  assert.equal(calls.entries[0].type, SUBAGENT_POOL_SWITCH_TYPE);
  assert.equal(calls.entries[0].data.reason, "transient");
  assert.equal(calls.entries[0].data.to.id, B.id);
  assert.equal(calls.emit[0].switchedTo, "my-anthropic-2/claude-sonnet-4-6");
});

test("auth and quota switch on the first retry without waiting out the same-model budget", async () => {
  resetSubagentPoolCooldownForTests();
  for (const [text, reason] of [
    ["401 Unauthorized", "auth"],
    ["insufficient_quota: billing", "quota"],
  ]) {
    const { session, calls } = host();
    installSubagentPoolFailover(session, [A, B]);
    const message = errorMessage(text);
    assert.equal(session._isRetryableError(message), true);
    assert.equal(await session._prepareRetry(message), true);
    assert.equal(calls.prepare, 0);
    assert.equal(calls.setModel[0], B);
    assert.deepEqual(calls.persist, [false]);
    assert.equal(calls.entries[0].data.reason, reason);
  }
});

test("abort, overflow, and a user stop never call setModel", async () => {
  resetSubagentPoolCooldownForTests();
  const { session, calls } = host();
  installSubagentPoolFailover(session, [A, B]);
  for (const message of [
    errorMessage("This operation was aborted."),
    errorMessage("The operation was aborted"),
    errorMessage("prompt is too long: 213462 tokens > 200000 maximum"),
    { stopReason: "aborted", errorMessage: "cancelled", content: [] },
  ]) {
    assert.equal(session._isRetryableError(message), false);
    assert.equal(await session._prepareRetry(message), false);
  }
  session._agentRunAbortRequested = true;
  assert.equal(await session._prepareRetry(errorMessage("429 rate limit")), false);
  assert.equal(calls.setModel.length, 0);
  assert.ok(calls.persist.every((value) => value !== true));
});

test("setModel is never called with persist true, including when omit is missing", async () => {
  resetSubagentPoolCooldownForTests();
  const { session, calls } = host({ noOmit: true });
  installSubagentPoolFailover(session, [A, B]);
  assert.equal(await session._prepareRetry(errorMessage("invalid_api_key")), true);
  assert.deepEqual(calls.persist, [false]);
  assert.equal(calls.omit, 0);
});

test("pool exhaustion returns false after the last member", async () => {
  resetSubagentPoolCooldownForTests();
  const { session, calls } = host();
  installSubagentPoolFailover(session, [A, B]);
  assert.equal(await session._prepareRetry(errorMessage("401 Unauthorized")), true);
  assert.equal(session.model, B);
  assert.equal(session._isRetryableError(errorMessage("401 Unauthorized")), false);
  assert.equal(await session._prepareRetry(errorMessage("401 Unauthorized")), false);
  assert.equal(calls.setModel.length, 1);
});

test("cooldown skips a just-failed member for a later run", () => {
  resetSubagentPoolCooldownForTests();
  markSubagentPoolCooldown("anthropic/claude-sonnet-4-6");
  assert.equal(isSubagentPoolCooling("anthropic/claude-sonnet-4-6"), true);
  assert.equal(selectPoolStart([A, B]), B);
  const next = pickNextPoolMember([A, B, C], {
    current: A,
    used: new Set(["anthropic/claude-sonnet-4-6"]),
  });
  assert.equal(next, B);
  resetSubagentPoolCooldownForTests();
  assert.equal(selectPoolStart([A, B]), A);
});

test("stream-drop retries stay true when the pool patch wraps retryStreamDrops", () => {
  resetSubagentPoolCooldownForTests();
  const session = {
    _modelForMessage: () => undefined,
    _isRetryableError: AgentSession.prototype._isRetryableError,
    _prepareRetry: async () => false,
    model: A,
  };
  retryStreamDrops(session);
  installSubagentPoolFailover(session, [A, B]);
  assert.equal(session._isRetryableError(errorMessage("relay: http/2 stream dropped while streaming tools")), true);
  assert.equal(session._isRetryableError(errorMessage("This operation was aborted.")), false);
});
