import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { runPromptToCompletion, waitUntilIdle, routineRunBranch } = await createJiti(import.meta.url).import("./routine-runner.ts");

/** Fake wrapper: `script(fake)` runs after the prompt is accepted and drives events. */
function fakeSession(script) {
  const listeners = new Set();
  const fake = {
    running: false,
    sent: [],
    inner: { messages: [] },
    emit: (event) => { for (const listener of listeners) listener(event); },
    isRunning: () => fake.running,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async send(command) {
      fake.sent.push(command.type);
      if (command.type === "prompt") { fake.running = true; queueMicrotask(() => script(fake)); }
      if (command.type === "abort") { fake.running = false; fake.emit({ type: "prompt_done", aborted: true }); }
      return null;
    },
  };
  return fake;
}

test("waits past an intermediate terminal event until the session is idle", async () => {
  const session = fakeSession((fake) => {
    fake.emit({ type: "prompt_done", aborted: false }); // still running: queued follow-up
    setTimeout(() => {
      fake.running = false;
      fake.inner.messages.push({ role: "assistant", stopReason: "stop" });
      fake.emit({ type: "agent_settled", aborted: false });
    }, 5);
  });
  assert.deepEqual(await runPromptToCompletion(session, "go", 1000), { status: "succeeded" });
});

test("reports model errors, prompt errors and aborts", async () => {
  const modelError = fakeSession((fake) => {
    fake.running = false;
    fake.inner.messages.push({ role: "assistant", stopReason: "error", errorMessage: "502" });
    fake.emit({ type: "prompt_done", aborted: false });
  });
  assert.deepEqual(await runPromptToCompletion(modelError, "go", 1000), { status: "failed", error: "502" });

  const promptError = fakeSession((fake) => {
    fake.running = false;
    fake.emit({ type: "prompt_error", errorMessage: "boom" });
    fake.emit({ type: "prompt_done", aborted: false });
  });
  assert.deepEqual(await runPromptToCompletion(promptError, "go", 1000), { status: "failed", error: "boom" });

  const aborted = fakeSession((fake) => {
    fake.running = false;
    fake.emit({ type: "prompt_done", aborted: true });
  });
  assert.deepEqual(await runPromptToCompletion(aborted, "go", 1000), { status: "aborted" });
});

test("aborts the session at the deadline", async () => {
  const session = fakeSession(() => {});
  const outcome = await runPromptToCompletion(session, "go", 20);
  assert.equal(outcome.status, "timed_out");
  assert.deepEqual(session.sent, ["prompt", "abort"]);
});

test("the deadline covers a prompt stuck in admission and an abort that never returns", async () => {
  const sent = [];
  const session = {
    inner: { messages: [] },
    isRunning: () => true,
    onEvent: () => () => {},
    // An extension command waiting on a dialog: neither the prompt nor the abort resolves.
    send(command) { sent.push(command.type); return new Promise(() => {}); },
  };
  const started = Date.now();
  const outcome = await runPromptToCompletion(session, "/ask", 20, 20);
  assert.equal(outcome.status, "timed_out");
  assert.deepEqual(sent, ["prompt", "abort"]);
  assert.ok(Date.now() - started < 1000);
});

test("a prompt rejected at admission fails the run", async () => {
  const session = fakeSession(() => {});
  session.send = async () => { throw new Error("Cannot send a prompt"); };
  await assert.rejects(runPromptToCompletion(session, "go", 1000), /Cannot send/);
});

test("a busy chat is waited for until idle, or given up at the deadline", async () => {
  let checks = 0;
  assert.equal(await waitUntilIdle(() => ++checks < 3, Date.now() + 1000, 5), true);
  assert.equal(checks, 3);
  assert.equal(await waitUntilIdle(() => true, Date.now() + 20, 5), false);
  assert.equal(await waitUntilIdle(() => false, Date.now() - 1, 5), true);
});

test("an isolated run's branch names the routine and when the run was due", () => {
  const due = new Date(2026, 10, 2, 9, 5).toISOString();
  assert.equal(routineRunBranch({ id: "2fd662d1-aaaa" }, { scheduledFor: due, startedAt: due }), "routine/2fd662d1-20261102-0905");
});
