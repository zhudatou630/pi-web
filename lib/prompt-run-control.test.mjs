import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  PromptRunGate,
  dispatchPromptRun,
  resolveStopCommand,
} = await createJiti(import.meta.url).import("./prompt-run-control.ts");

test("cancelling an unsent run abandons it without affecting a later run", async () => {
  const gate = new PromptRunGate();
  const log = [];
  const delay = () => new Promise((resolve) => setTimeout(resolve, 5));

  const send = async (runId) => {
    log.push(`start:${runId}`);
    const result = await dispatchPromptRun({
      gate,
      runId,
      currentRunId: () => runId,
      currentSessionId: () => "s1",
      promptPending: () => true,
      prepare: async () => {
        await delay();
        return "s1";
      },
      send: async () => {
        log.push(`prompt:${runId}`);
      },
      abort: async () => {
        log.push(`abort:${runId}`);
      },
      abandonUnsent: () => {
        log.push(`abandoned:${runId}`);
      },
    });
    return result.status;
  };

  const first = send(1);
  gate.cancel(1);
  assert.equal(await first, "abandoned");
  assert.equal(await send(2), "sent");

  assert.deepEqual(log, ["start:1", "abandoned:1", "start:2", "prompt:2"]);
  assert.equal(gate.isCancelled(1), false);
  assert.equal(gate.wasDispatched(1), false);
  assert.equal(gate.isInFlight(1), false);
  assert.equal(gate.isInFlight(2), false);
});

test("a cancel after dispatch still requests a server abort", async () => {
  const gate = new PromptRunGate();
  gate.begin(3);
  gate.markDispatched(3);
  gate.cancel(3);
  assert.equal(gate.shouldAbandonUnsent(3), false);
  assert.equal(gate.wasDispatched(3), true);
  assert.equal(gate.isCancelled(3), true);
  assert.equal(resolveStopCommand({
    bashRunning: false,
    hasSessionId: true,
    localUnsent: false,
    agentRunning: true,
  }), "abort");
});

test("stop before a session exists only records local cancel", () => {
  assert.equal(resolveStopCommand({
    bashRunning: false,
    hasSessionId: false,
    localUnsent: false,
    agentRunning: true,
  }), "none");
  assert.equal(resolveStopCommand({
    bashRunning: true,
    hasSessionId: false,
    localUnsent: false,
    agentRunning: false,
  }), "none");
  assert.equal(resolveStopCommand({
    bashRunning: true,
    hasSessionId: true,
    localUnsent: false,
    agentRunning: false,
  }), "abort_bash");
});

test("a locally unsent run is not aborted even when a session id already exists", () => {
  assert.equal(resolveStopCommand({
    bashRunning: false,
    hasSessionId: true,
    localUnsent: true,
    agentRunning: true,
  }), "none");
});

test("server-confirmed running is abortable without a local dispatch mark", () => {
  assert.equal(resolveStopCommand({
    bashRunning: false,
    hasSessionId: true,
    localUnsent: false,
    agentRunning: true,
  }), "abort");
});
