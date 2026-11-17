import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const rpc = jiti("./rpc-manager.ts");
const notifications = jiti("./routine-notify.ts");
const { executeRoutineRun, runPromptToCompletion, waitUntilIdle, routineRunBranch } = await jiti.import("./routine-runner.ts");
// Mocked once for the file: a second t.mock.method on this (accessor) export does not take.
let startSession;
const start = mock.method(rpc, "startRpcSession", async (...args) => startSession(...args));

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

const reply = (text, extra = {}) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra } });

test("waits past an intermediate terminal event until the session is idle", async () => {
  const session = fakeSession((fake) => {
    fake.emit({ type: "prompt_done", aborted: false }); // still running: queued follow-up
    setTimeout(() => {
      fake.running = false;
      fake.emit(reply("done"));
      fake.emit({ type: "agent_settled", aborted: false });
    }, 5);
  });
  assert.deepEqual(await runPromptToCompletion(session, "go", 1000), { status: "succeeded" });
});

test("reports model errors, prompt errors and aborts", async () => {
  const modelError = fakeSession((fake) => {
    fake.running = false;
    fake.emit(reply("", { stopReason: "error", errorMessage: "502" }));
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
  const outcome = await runPromptToCompletion(session, "/ask", 20, { abortGraceMs: 20 });
  assert.equal(outcome.status, "timed_out");
  assert.deepEqual(sent, ["prompt", "abort"]);
  assert.ok(Date.now() - started < 1000);
});

test("progress is this prompt's last routine-progress block; an earlier run's reply never counts", async () => {
  const session = fakeSession((fake) => {
    fake.emit(reply("Scanning\n```routine-progress\ncovered to 09:00\n```"));
    fake.emit(reply("Report.\n\n```routine-progress\ncovered to 10:00;\n  night gap still open\n```\n"));
    fake.emit(reply("No block in the last one."));
    fake.running = false;
    fake.emit({ type: "prompt_done", aborted: false });
  });
  // Settles from `before` (a compaction) and a stale error from an earlier run are not this prompt.
  const before = async () => {
    session.emit(reply("", { stopReason: "error", errorMessage: "old" }));
    session.emit({ type: "agent_settled", aborted: false });
  };
  assert.deepEqual(await runPromptToCompletion(session, "go", 1000, { before }), { status: "succeeded", progress: "covered to 10:00; night gap still open" });

  const silent = fakeSession((fake) => { fake.running = false; fake.emit({ type: "prompt_done", aborted: false }); });
  assert.deepEqual(await runPromptToCompletion(silent, "/cmd", 1000), { status: "succeeded" });
});

test("the deadline covers a before step that never finishes", async () => {
  const session = fakeSession(() => {});
  const outcome = await runPromptToCompletion(session, "go", 20, { abortGraceMs: 20, before: () => new Promise(() => {}) });
  assert.equal(outcome.status, "timed_out");
  assert.deepEqual(session.sent, ["abort"]);
});

test("a compaction cancelled by the timeout or by Stop never leads to a prompt", async () => {
  // The timeout's abort cancels the compaction; the before step then must not go on.
  const late = fakeSession(() => {});
  let cancel;
  const send = late.send.bind(late);
  late.send = (command) => { if (command.type === "abort") cancel(); return send(command); };
  const steps = [];
  const outcome = await runPromptToCompletion(late, "go", 20, {
    abortGraceMs: 20,
    before: async (stopped) => {
      await new Promise((resolve) => { cancel = resolve; });
      if (!stopped()) steps.push("memory");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(outcome.status, "timed_out");
  assert.deepEqual([late.sent, steps], [["abort"], []]);

  // Stop pressed during the compaction: the run ends as aborted.
  const stoppedByUser = fakeSession(() => {});
  const aborted = await runPromptToCompletion(stoppedByUser, "go", 1000, {
    before: async () => { stoppedByUser.emit({ type: "compaction_end", aborted: true }); },
  });
  assert.deepEqual([aborted, stoppedByUser.sent], [{ status: "aborted" }, []]);
});

test("startup naming preserves both session names without blocking the prompt deadline", { timeout: 2000 }, async (t) => {
  let session;
  startSession = async () => ({ session, realSessionId: "run-chat" });
  t.mock.method(notifications, "notifyRoutine", () => {});
  for (const kind of ["new_session", "same_session"]) {
    session = fakeSession(() => {});
    session.inner.setSessionName = t.mock.fn((name) => { session.name = name; });
    session.markRoutineRun = t.mock.fn(() => session.sent.push("mark"));
    session.endRoutineRun = t.mock.fn();
    session.inner.getContextUsage = () => ({ tokens: 10 });
    session.inner.getActiveToolNames = () => ["read", "bash", "routines"];
    session.inner.sendCustomMessage = t.mock.fn(async () => { session.sent.push("memory"); });
    const send = session.send.bind(session);
    session.send = (command) => {
      // Startup is parked on a dialog: naming via send() and prompting would both wait.
      if (command.type === "abort") return send(command);
      session.sent.push(command.type);
      return new Promise(() => {});
    };
    const store = { updateRun: t.mock.fn(async () => {}), bindSession: t.mock.fn(async () => {}), list: () => [] };
    const at = new Date(2026, 10, 2, 9, 5).toISOString();
    const routine = {
      id: "routine", name: "Daily check", prompt: "go", timeoutMinutes: 20 / 60_000,
      target: { kind, cwd: process.cwd() }, runs: [],
    };
    const run = { runId: "run", startedAt: at, scheduledFor: at };

    await executeRoutineRun(store, routine, run);

    assert.equal(session.name, kind === "same_session" ? "Daily check" : "Daily check · 2026-11-02 09:05");
    assert.equal(session.inner.setSessionName.mock.callCount(), 1);
    // Memory, then the marker, then the prompt (nothing between marker and prompt).
    assert.deepEqual(session.sent, ["memory", "mark", "prompt", "abort"]);
    const [memory, options] = session.inner.sendCustomMessage.mock.calls[0].arguments;
    assert.equal(memory.display, false);
    assert.match(memory.content, /routines tool \(id routine, memory\)/);
    assert.deepEqual(options, { triggerTurn: false });
    assert.equal(start.mock.calls.at(-1).arguments[3].persistStartupPreferences, false);
    assert.deepEqual(store.updateRun.mock.calls[0].arguments, ["routine", "run", { sessionId: "run-chat" }]);
    assert.equal(store.updateRun.mock.calls.at(-1).arguments[2].status, "timed_out");
    assert.deepEqual(store.bindSession.mock.calls.map((call) => call.arguments), kind === "same_session" ? [["routine", "run-chat"]] : []);
    assert.equal(session.endRoutineRun.mock.callCount(), 1);
  }
});

test("a continued chat past the threshold is compacted before the memory and marker", { timeout: 2000 }, async (t) => {
  t.mock.method(notifications, "notifyRoutine", () => {});
  const session = fakeSession((fake) => { fake.running = false; fake.emit({ type: "prompt_done", aborted: false }); });
  startSession = async () => ({ session, realSessionId: "chat" });
  Object.assign(session, { markRoutineRun: () => session.sent.push("mark"), endRoutineRun: () => {} });
  Object.assign(session.inner, {
    setSessionName: () => {},
    getContextUsage: () => ({ tokens: 200_000 }),
    // Read-only tools: the run is told the memory is the user's to edit.
    getActiveToolNames: () => ["read", "routines"],
    sendCustomMessage: async (message) => { session.sent.push("memory"); session.memory = message.content; },
  });
  const store = { updateRun: t.mock.fn(async () => {}), bindSession: async () => {}, list: () => [] };
  const at = new Date().toISOString();
  const routine = { id: "r", name: "Watch", prompt: "go", timeoutMinutes: 1, target: { kind: "same_session", cwd: process.cwd() }, runs: [] };
  await executeRoutineRun(store, routine, { runId: "run", startedAt: at, scheduledFor: at });
  assert.deepEqual(session.sent, ["compact", "memory", "mark", "prompt"]);
  assert.match(session.memory, /edits the memory on the Routines page/);
  assert.equal(store.updateRun.mock.calls.at(-1).arguments[2].status, "succeeded");
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
