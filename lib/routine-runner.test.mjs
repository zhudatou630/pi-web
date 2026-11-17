import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const rpc = jiti("./rpc-manager.ts");
const notifications = jiti("./routine-notify.ts");
const { executeRoutineRun, runPromptToCompletion, waitUntilIdle, routineRunBranch } = await jiti.import("./routine-runner.ts");

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

test("startup naming preserves both session names without blocking the prompt deadline", { timeout: 2000 }, async (t) => {
  let session;
  const start = t.mock.method(rpc, "startRpcSession", async () => ({ session, realSessionId: "run-chat" }));
  t.mock.method(notifications, "notifyRoutine", () => {});
  for (const kind of ["new_session", "same_session"]) {
    session = fakeSession(() => {});
    session.inner.setSessionName = t.mock.fn((name) => { session.name = name; });
    session.markRoutineRun = t.mock.fn();
    session.endRoutineRun = t.mock.fn();
    const send = session.send.bind(session);
    session.send = (command) => {
      // Startup is parked on a dialog: naming via send() and prompting would both wait.
      if (command.type === "abort") return send(command);
      session.sent.push(command.type);
      return new Promise(() => {});
    };
    const store = { updateRun: t.mock.fn(async () => {}), bindSession: t.mock.fn(async () => {}) };
    const at = new Date(2026, 10, 2, 9, 5).toISOString();
    const routine = {
      id: "routine", name: "Daily check", prompt: "go", timeoutMinutes: 20 / 60_000,
      target: { kind, cwd: process.cwd() },
    };
    const run = { runId: "run", startedAt: at, scheduledFor: at };

    await executeRoutineRun(store, routine, run);

    assert.equal(session.name, kind === "same_session" ? "Daily check" : "Daily check · 2026-11-02 09:05");
    assert.equal(session.inner.setSessionName.mock.callCount(), 1);
    assert.deepEqual(session.sent, ["prompt", "abort"]);
    assert.equal(start.mock.calls.at(-1).arguments[3].persistStartupPreferences, false);
    assert.deepEqual(store.updateRun.mock.calls[0].arguments, ["routine", "run", { sessionId: "run-chat" }]);
    assert.equal(store.updateRun.mock.calls.at(-1).arguments[2].status, "timed_out");
    assert.deepEqual(store.bindSession.mock.calls.map((call) => call.arguments), kind === "same_session" ? [["routine", "run-chat"]] : []);
    assert.equal(session.endRoutineRun.mock.callCount(), 1);
  }
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
