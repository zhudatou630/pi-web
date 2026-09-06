import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  PromptRunGate,
  dispatchBashRun,
  dispatchPromptRun,
  resolveStopCommand,
} = await createJiti(import.meta.url).import("./prompt-run-control.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createComposer() {
  const gate = new PromptRunGate();
  const state = {
    promptRunId: 0,
    sessionId: null,
    agentRunning: false,
    rpcPromptPending: false,
    pending: null,
    bashRunning: false,
    bashAbortRequested: false,
    messages: [],
    draft: null,
    loadedSessions: [],
    commands: [],
    notices: [],
    restored: [],
    reconciled: [],
  };

  const currentRunId = () => state.promptRunId;
  const currentSessionId = () => state.sessionId;

  const restore = (text) => {
    state.draft = text;
    state.restored.push(text);
  };

  const abandonUnsent = (runId) => {
    if (state.pending?.runId !== runId) return;
    const pending = state.pending;
    state.pending = null;
    state.rpcPromptPending = false;
    const idx = state.messages.lastIndexOf(pending.userMsg);
    if (idx !== -1) state.messages.splice(idx, 1);
    restore(pending.message);
    if (state.promptRunId === runId) state.agentRunning = false;
  };

  const abortSession = async (sid) => {
    state.commands.push({ type: "abort", sessionId: sid });
  };

  async function handleSend(message, { prepare, send } = {}) {
    if (state.agentRunning || state.bashRunning) {
      restore(message);
      return { blocked: true };
    }
    const runId = state.promptRunId + 1;
    const userMsg = { role: "user", content: message };
    state.messages.push(userMsg);
    state.promptRunId = runId;
    state.agentRunning = true;
    state.rpcPromptPending = true;
    state.pending = { runId, message, userMsg };
    gate.begin(runId);

    const result = await dispatchPromptRun({
      gate,
      runId,
      currentRunId,
      currentSessionId,
      promptPending: () => state.rpcPromptPending,
      abandonUnsent: () => abandonUnsent(runId),
      onDispatched: () => {
        if (state.pending?.runId === runId) state.pending = null;
      },
      abort: abortSession,
      prepare: prepare ?? (async () => state.sessionId),
      send: send ?? (async (sid) => {
        state.commands.push({ type: "prompt", sessionId: sid, message });
      }),
    });

    if (result.status === "cancelled_after_dispatch") {
      state.reconciled.push({ reason: "cancel", sessionId: result.sessionId, runId });
    } else if (result.status === "failed") {
      const definitivelyRejected = !result.requestStarted;
      if (!definitivelyRejected && result.sessionId) {
        state.reconciled.push({ reason: "network", sessionId: result.sessionId, runId });
        return result;
      }
      state.rpcPromptPending = false;
      if (state.pending?.runId === runId) state.pending = null;
      const idx = state.messages.lastIndexOf(userMsg);
      if (idx !== -1) state.messages.splice(idx, 1);
      state.notices.push(result.error);
      restore(message);
      if (result.sessionId) {
        state.reconciled.push({ reason: "reject", sessionId: result.sessionId, runId });
      } else {
        state.agentRunning = false;
      }
    }
    return result;
  }

  async function handleAbort() {
    const runId = state.promptRunId;
    const sid = state.sessionId;
    if (state.bashRunning) {
      state.bashAbortRequested = true;
      if (!sid) return "none";
      state.commands.push({ type: "abort_bash", sessionId: sid });
      return "abort_bash";
    }

    const pending = state.pending;
    if (gate.isInFlight(runId) || pending?.runId === runId) {
      gate.cancel(runId);
    }

    const localUnsent = Boolean(
      pending
      && pending.runId === runId
      && gate.shouldAbandonUnsent(runId),
    );
    if (localUnsent && pending) {
      state.pending = null;
      state.rpcPromptPending = false;
      const idx = state.messages.lastIndexOf(pending.userMsg);
      if (idx !== -1) state.messages.splice(idx, 1);
      restore(pending.message);
      state.agentRunning = false;
      return "abandoned";
    }

    const command = resolveStopCommand({
      bashRunning: false,
      hasSessionId: Boolean(sid),
      localUnsent,
      agentRunning: state.agentRunning || state.rpcPromptPending,
    });
    if (command === "none" || !sid) return command;
    state.commands.push({ type: command, sessionId: sid });
    return command;
  }

  async function executeBash(command, { prepare, send, loadResults } = {}) {
    if (state.agentRunning || state.bashRunning) return { blocked: true };
    state.bashAbortRequested = false;
    state.bashRunning = true;
    try {
      return await dispatchBashRun({
        abortRequested: () => state.bashAbortRequested,
        prepare: prepare ?? (async () => state.sessionId),
        send: send ?? (async (sid) => {
          state.commands.push({ type: "bash", sessionId: sid, command });
        }),
        loadResults: loadResults ?? (async (sid) => {
          state.loadedSessions.push(sid);
        }),
        restoreUnsent: () => restore(`!${command}`),
      });
    } finally {
      state.bashRunning = false;
    }
  }

  return { gate, state, handleSend, handleAbort, executeBash };
}

test("refreshing an already-running session can stop without a local dispatch mark", async () => {
  const { gate, state, handleAbort } = createComposer();
  state.sessionId = "s-refresh";
  state.promptRunId = 0;
  state.agentRunning = true;
  state.rpcPromptPending = true;

  assert.equal(gate.wasDispatched(0), false);
  assert.equal(await handleAbort(), "abort");
  assert.deepEqual(state.commands, [{ type: "abort", sessionId: "s-refresh" }]);
  assert.equal(state.draft, null);
});

test("a queued or streaming prompt that starts a run can be stopped", async () => {
  const { state, handleAbort } = createComposer();
  state.sessionId = "s-queue";
  state.promptRunId = 4;
  state.agentRunning = true;
  state.rpcPromptPending = false;

  assert.equal(await handleAbort(), "abort");
  assert.deepEqual(state.commands, [{ type: "abort", sessionId: "s-queue" }]);
});

test("cancelling while creating a session or waiting for SSE never sends the prompt and restores the draft", async () => {
  const { state, handleSend, handleAbort } = createComposer();
  const ready = deferred();
  const sse = deferred();
  let sent = 0;

  const sending = handleSend("hello", {
    prepare: async () => {
      state.sessionId = "s-new";
      ready.resolve();
      await sse.promise;
      return "s-new";
    },
    send: async () => {
      sent += 1;
    },
  });

  await ready.promise;
  assert.equal(state.agentRunning, true);
  assert.equal(state.messages.length, 1);
  assert.equal(await handleAbort(), "abandoned");
  assert.equal(state.draft, "hello");
  assert.equal(state.messages.length, 0);
  assert.equal(state.agentRunning, false);

  sse.resolve();
  assert.equal((await sending).status, "abandoned");
  assert.equal(sent, 0);
  assert.equal(state.commands.length, 0);
  assert.deepEqual(state.restored, ["hello"]);
});

test("a late return from an old prompt does not abort a newer run on the same session", async () => {
  const { state, handleSend, handleAbort } = createComposer();
  state.sessionId = "s-same";
  const firstEntered = deferred();
  const firstSend = deferred();
  const secondEntered = deferred();
  const secondSend = deferred();

  const first = handleSend("one", {
    send: async (sid) => {
      state.commands.push({ type: "prompt", sessionId: sid, message: "one" });
      firstEntered.resolve();
      await firstSend.promise;
    },
  });
  await firstEntered.promise;
  assert.equal(await handleAbort(), "abort");

  state.agentRunning = false;
  state.rpcPromptPending = false;
  const second = handleSend("two", {
    send: async (sid) => {
      state.commands.push({ type: "prompt", sessionId: sid, message: "two" });
      secondEntered.resolve();
      await secondSend.promise;
    },
  });
  await secondEntered.promise;
  assert.equal(state.promptRunId, 2);
  assert.equal(state.agentRunning, true);

  firstSend.resolve();
  assert.equal((await first).status, "stale");
  assert.deepEqual(
    state.commands.filter((item) => item.type === "abort"),
    [{ type: "abort", sessionId: "s-same" }],
  );

  secondSend.resolve();
  assert.equal((await second).status, "sent");
  assert.equal(state.promptRunId, 2);
  assert.deepEqual(
    state.commands.filter((item) => item.type === "prompt").map((item) => item.message),
    ["one", "two"],
  );
});

test("a completed prompt's late reply cannot stop a run started by another tab", async () => {
  const { state, handleSend, handleAbort } = createComposer();
  state.sessionId = "shared";
  const admitted = deferred();
  const reply = deferred();
  const sending = handleSend("old", {
    send: async () => {
      admitted.resolve();
      await reply.promise;
    },
  });
  await admitted.promise;
  await handleAbort();
  // Terminal SSE settles the old submission. A different tab starts a new
  // run: local promptRunId is unchanged, but our submission is no longer pending.
  state.rpcPromptPending = false;
  state.agentRunning = true;
  const runId = state.promptRunId;
  reply.resolve();
  assert.equal((await sending).status, "stale");
  assert.equal(state.promptRunId, runId);
  assert.equal(state.commands.filter((item) => item.type === "abort").length, 1);
});

test("cancelling a dispatched network failure reconciles instead of restoring the draft", async () => {
  const { state, handleSend, handleAbort } = createComposer();
  state.sessionId = "s-net";
  const entered = deferred();
  const sendGate = deferred();

  const sending = handleSend("keep me", {
    send: async () => {
      entered.resolve();
      await sendGate.promise;
      throw new Error("connection reset");
    },
  });
  await entered.promise;
  assert.equal(await handleAbort(), "abort");
  sendGate.resolve();

  const result = await sending;
  assert.equal(result.status, "cancelled_after_dispatch");
  assert.deepEqual(state.reconciled, [{ reason: "cancel", sessionId: "s-net", runId: 1 }]);
  assert.equal(state.draft, null);
  assert.equal(state.messages.length, 1);
});

test("an uncancelled dispatched network failure still reconciles", async () => {
  const { state, handleSend } = createComposer();
  state.sessionId = "s-net2";

  const result = await handleSend("later", {
    send: async () => {
      throw new Error("proxy blip");
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.requestStarted, true);
  assert.deepEqual(state.reconciled, [{ reason: "network", sessionId: "s-net2", runId: 1 }]);
  assert.equal(state.draft, null);
  assert.equal(state.messages.length, 1);
});

test("bash cancel after dispatch loads results and does not restore the command", async () => {
  const { state, handleAbort, executeBash } = createComposer();
  state.sessionId = "s-bash";
  const entered = deferred();
  const bash = deferred();

  const running = executeBash("ls", {
    send: async (sid) => {
      state.commands.push({ type: "bash", sessionId: sid, command: "ls" });
      entered.resolve();
      await bash.promise;
    },
  });
  await entered.promise;
  assert.equal(state.bashRunning, true);
  assert.equal(await handleAbort(), "abort_bash");

  bash.resolve({ stdout: "done" });
  const result = await running;
  assert.equal(result.status, "cancelled_after_dispatch");
  assert.deepEqual(state.loadedSessions, ["s-bash"]);
  assert.equal(state.draft, null);
  assert.deepEqual(state.restored, []);
});

test("bash cancel before dispatch restores the command and never sends", async () => {
  const { state, handleAbort, executeBash } = createComposer();
  const ready = deferred();
  const created = deferred();
  let sent = 0;

  const running = executeBash("pwd", {
    prepare: async () => {
      state.sessionId = "s-bash-new";
      ready.resolve();
      await created.promise;
      return "s-bash-new";
    },
    send: async () => {
      sent += 1;
    },
  });
  await ready.promise;
  assert.equal(await handleAbort(), "abort_bash");
  created.resolve();

  const result = await running;
  assert.equal(result.status, "restored_unsent");
  assert.equal(sent, 0);
  assert.deepEqual(state.restored, ["!pwd"]);
  assert.deepEqual(state.loadedSessions, []);
});

test("bash cancel that rejects after dispatch still loads results", async () => {
  const { state, handleAbort, executeBash } = createComposer();
  state.sessionId = "s-bash-err";
  const entered = deferred();
  const bash = deferred();

  const running = executeBash("sleep 1", {
    send: async () => {
      entered.resolve();
      await bash.promise;
    },
  });
  await entered.promise;
  await handleAbort();
  bash.reject(new Error("aborted"));

  const result = await running;
  assert.equal(result.status, "cancelled_after_dispatch");
  assert.deepEqual(state.loadedSessions, ["s-bash-err"]);
  assert.deepEqual(state.restored, []);
});

test("forget after a finished run still leaves a later in-flight cancel observable", async () => {
  const { gate, state, handleSend, handleAbort } = createComposer();
  state.sessionId = "s-clean";
  const first = await handleSend("done");
  assert.equal(first.status, "sent");
  assert.equal(gate.isInFlight(1), false);
  assert.equal(gate.wasDispatched(1), false);
  // A successful POST acknowledges admission, not completion. Simulate the
  // terminal SSE before attempting the next submission.
  state.agentRunning = false;
  state.rpcPromptPending = false;

  const ready = deferred();
  const blocked = deferred();
  const second = handleSend("next", {
    prepare: async () => {
      ready.resolve();
      await blocked.promise;
      return "s-clean";
    },
  });
  await ready.promise;
  assert.equal(await handleAbort(), "abandoned");
  blocked.resolve();
  assert.equal((await second).status, "abandoned");
  assert.equal(gate.isCancelled(2), false);
  assert.equal(gate.isInFlight(2), false);
});
