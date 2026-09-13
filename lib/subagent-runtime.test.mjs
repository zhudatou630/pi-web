import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  advanceSubagentTurnLimit,
  buildParentContextText,
  commitSubagentTerminal,
  createSubagentController,
  deriveSubagentOutcome,
  isSubagentQueued,
  projectInstructionsForSubagent,
} = await createJiti(import.meta.url).import("./subagent-runtime.ts");

function assistant(content, stopReason = "stop", errorMessage) {
  return {
    role: "assistant",
    content,
    provider: "test",
    model: "test",
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

test("parent context keeps conversational text and summaries without storage payloads", () => {
  const context = buildParentContextText([
    { role: "user", content: [{ type: "text", text: "Inspect auth" }, { type: "image", data: "large" }] },
    assistant([
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "The auth check is missing" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "secret.ts" } },
    ]),
    { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "large tool output" }] },
    { role: "compactionSummary", summary: "The team chose middleware", tokensBefore: 1000, timestamp: 1 },
    { role: "custom", customType: "notice", content: "UI-only notice", display: true, timestamp: 2 },
  ]);

  assert.equal(context, [
    "[User]\nInspect auth",
    "[Assistant]\nThe auth check is missing",
    "[Summary]\nThe team chose middleware",
  ].join("\n\n"));
  assert.doesNotMatch(context, /private reasoning|secret\.ts|large tool output|UI-only notice|large/);
});

test("parent context keeps recent complete messages when the limit is reached", () => {
  const context = buildParentContextText([
    { role: "user", content: [{ type: "text", text: "old context that does not fit" }] },
    assistant([{ type: "text", text: "recent answer" }]),
    { role: "user", content: [{ type: "text", text: "latest question" }] },
  ], 85);

  assert.equal(context, [
    "[Earlier parent context omitted]",
    "[Assistant]\nrecent answer",
    "[User]\nlatest question",
  ].join("\n\n"));
  assert.doesNotMatch(context, /old context/);
});

test("parent context enforces its limit in UTF-8 bytes including the omission note", () => {
  const oversized = buildParentContextText([
    { role: "user", content: [{ type: "text", text: "汉".repeat(20_000) }] },
  ]);
  assert.equal(oversized, "[Earlier parent context omitted]");
  assert.ok(Buffer.byteLength(oversized, "utf8") <= 50_000);

  const section = `[User]\n${"x".repeat(100)}`;
  assert.equal(
    buildParentContextText([{ role: "user", content: [{ type: "text", text: "x".repeat(100) }] }], Buffer.byteLength(section)),
    section,
  );
  assert.equal(
    buildParentContextText([{ role: "user", content: [{ type: "text", text: "x".repeat(100) }] }], Buffer.byteLength(section) - 1),
    "[Earlier parent context omitted]",
  );
});

test("only the built-in general-purpose agent inherits loaded project instructions", () => {
  const files = [
    { path: "/repo/AGENTS.md", content: "Global project rules" },
    { path: "/repo/src/AGENTS.md", content: "Nested project rules" },
  ];

  assert.equal(
    projectInstructionsForSubagent({ name: "general-purpose", scope: "builtin" }, files),
    "Global project rules\n\nNested project rules",
  );
  assert.equal(
    projectInstructionsForSubagent({ name: "general-purpose", scope: "project" }, files),
    undefined,
  );
  assert.equal(
    projectInstructionsForSubagent({ name: "explore", scope: "builtin" }, files),
    undefined,
  );
});

test("subagent outcomes preserve useful text before an aborted tail", () => {
  const outcome = deriveSubagentOutcome([
    assistant([{ type: "text", text: "Useful partial result" }]),
    assistant([{ type: "text", text: "" }], "aborted", "Request was aborted"),
  ], { abortRequested: false, turnLimitReached: false });

  assert.deepEqual(outcome, { status: "aborted", result: "Useful partial result" });
});

test("subagent outcomes report provider errors instead of completed without output", () => {
  const outcome = deriveSubagentOutcome([
    assistant([], "error", "Provider unavailable"),
  ], { abortRequested: false, turnLimitReached: false });

  assert.deepEqual(outcome, { status: "failed", error: "Provider unavailable" });
  assert.deepEqual(
    deriveSubagentOutcome([], { abortRequested: false, turnLimitReached: false }),
    { status: "failed", error: "Subagent completed without text output" },
  );
});

test("a terminal persistence failure is explicit and cannot become a ready result", () => {
  const run = completedRun();
  const committed = commitSubagentTerminal({
    appendCustomEntry() { throw new Error("disk full"); },
  }, run);

  assert.equal(committed.persisted, false);
  assert.equal(committed.run.status, "failed");
  assert.match(committed.run.error, /Failed to persist subagent result: disk full/);
});

test("turn limits accept a final response but reject a tool-only wrap-up", () => {
  assert.deepEqual(
    deriveSubagentOutcome([
      assistant([{ type: "text", text: "Final answer" }]),
    ], { abortRequested: false, turnLimitReached: true }),
    { status: "completed", wrappedAtTurnLimit: true, result: "Final answer" },
  );
  assert.deepEqual(
    deriveSubagentOutcome([
      assistant([{ type: "toolCall", id: "call", name: "read", arguments: {} }], "toolUse"),
    ], { abortRequested: false, turnLimitReached: true }),
    { status: "failed", error: "Subagent reached its turn limit before producing a final response" },
  );
  assert.deepEqual(
    deriveSubagentOutcome([
      assistant([
        { type: "text", text: "I will keep checking" },
        { type: "toolCall", id: "call", name: "read", arguments: {} },
      ], "toolUse"),
    ], { abortRequested: false, turnLimitReached: true }),
    {
      status: "failed",
      result: "I will keep checking",
      error: "Subagent reached its turn limit before producing a final response",
    },
  );
  assert.deepEqual(
    deriveSubagentOutcome([], { abortRequested: false, turnLimitReached: true }),
    { status: "failed", error: "Subagent reached its turn limit before producing a final response" },
  );
});

test("turn-limit transitions distinguish natural completion and the wrap-up turn", () => {
  const initial = { turnCount: 0, wrapUpRequested: false, turnLimitReached: false };
  const natural = advanceSubagentTurnLimit(
    initial,
    assistant([{ type: "text", text: "Natural answer" }]),
    1,
  );
  assert.deepEqual(natural, {
    state: { turnCount: 1, wrapUpRequested: false, turnLimitReached: false },
    requestWrapUp: false,
  });

  const limited = advanceSubagentTurnLimit(
    initial,
    assistant([{ type: "toolCall", id: "call", name: "read", arguments: {} }], "toolUse"),
    1,
  );
  assert.equal(limited.requestWrapUp, true);
  const wrapped = advanceSubagentTurnLimit(
    limited.state,
    assistant([{ type: "text", text: "Wrapped answer" }]),
    1,
  );
  assert.equal(wrapped.state.turnLimitReached, true);
  assert.deepEqual(
    deriveSubagentOutcome(
      [assistant([{ type: "text", text: "Wrapped answer" }])],
      { abortRequested: false, turnLimitReached: wrapped.state.turnLimitReached },
    ),
    { status: "completed", wrappedAtTurnLimit: true, result: "Wrapped answer" },
  );

  const unfinished = advanceSubagentTurnLimit(
    limited.state,
    assistant([{ type: "toolCall", id: "again", name: "read", arguments: {} }], "toolUse"),
    1,
  );
  assert.equal(unfinished.state.turnLimitReached, true);
  assert.equal(
    deriveSubagentOutcome(
      [assistant([{ type: "toolCall", id: "again", name: "read", arguments: {} }], "toolUse")],
      { abortRequested: false, turnLimitReached: unfinished.state.turnLimitReached },
    ).status,
    "failed",
  );
});

test("disabled built-in subagents reject stale Agent calls before starting", async () => {
  const controller = createSubagentController({
    getSession: () => { throw new Error("must not inspect a parent"); },
    registerSession: () => {},
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => false,
  });

  await assert.rejects(
    controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent" } },
      parentToolCallId: "call",
      profile: "explore",
      task: "Inspect",
      description: "Inspect",
    }),
    /built-in sub-agents are disabled/,
  );
});

test("queued ownership is exposed only while a live run is waiting", (t) => {
  const previousRuns = globalThis.__piSubagentRuns;
  globalThis.__piSubagentRuns = new Map([
    ["queued", { run: { status: "queued" } }],
    ["running", { run: { status: "running" } }],
  ]);
  t.after(() => { globalThis.__piSubagentRuns = previousRuns; });

  assert.equal(isSubagentQueued("queued"), true);
  assert.equal(isSubagentQueued("running"), false);
  assert.equal(isSubagentQueued("missing"), false);
});

function completedRun(overrides = {}) {
  return {
    sessionId: "child",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent",
    parentToolCallId: "call-1",
    profile: "explore",
    description: "Inspect code",
    task: "Inspect",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: "Done",
    ...overrides,
  };
}

function installPendingWave(t, run) {
  const previousWaves = globalThis.__piSubagentWaves;
  const previousParents = globalThis.__piSubagentNotificationParents;
  const key = `${run.sessionId}\0${run.parentToolCallId}`;
  globalThis.__piSubagentWaves = new Map([["wave", {
    parentSessionId: run.parentSessionId,
    members: [key],
    results: new Map([[key, run]]),
    pending: 0,
  }]]);
  globalThis.__piSubagentNotificationParents = new Set();
  t.after(() => {
    globalThis.__piSubagentWaves = previousWaves;
    globalThis.__piSubagentNotificationParents = previousParents;
  });
}

test("terminal result consumption suppresses the later parent notification", (t) => {
  const run = completedRun();
  installPendingWave(t, run);
  const sent = [];
  let parentRunning = true;
  const controller = createSubagentController({
    getSession: () => ({
      isAlive: () => true,
      isClosing: () => false,
      isRunning: () => parentRunning,
      inner: { sendCustomMessage: (...args) => { sent.push(args); return Promise.resolve(); } },
    }),
    registerSession: () => {},
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
  });

  assert.equal(controller.flushParentNotifications("parent"), false);
  assert.equal(controller.extensionRuntime.consume("parent", run), true);
  parentRunning = false;
  assert.equal(controller.flushParentNotifications("parent"), false);
  assert.deepEqual(sent, []);
});

test("a stopped parent does not receive a background notification", (t) => {
  const run = completedRun();
  installPendingWave(t, run);
  const sent = [];
  const controller = createSubagentController({
    getSession: () => ({
      isAlive: () => true,
      isClosing: () => false,
      isRunning: () => false,
      canStartBackgroundFollowUp: () => false,
      inner: { sendCustomMessage: (...args) => { sent.push(args); return Promise.resolve(); } },
    }),
    registerSession: () => {},
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
  });

  assert.equal(controller.flushParentNotifications("parent"), false);
  assert.deepEqual(sent, []);
  assert.equal(globalThis.__piSubagentWaves.get("wave").results.size, 1);
});

test("a closed parent drops only the in-memory notification copy", (t) => {
  const run = completedRun();
  installPendingWave(t, run);
  globalThis.__piSubagentWaves.get("wave").pending = 1;
  const controller = createSubagentController({
    getSession: () => undefined,
    registerSession: () => {},
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
  });

  assert.equal(controller.flushParentNotifications("parent"), false);
  assert.equal(globalThis.__piSubagentWaves.size, 0);
});

test("a notification failure restores results that never reached the parent session", async (t) => {
  const run = completedRun();
  installPendingWave(t, run);
  const previousConsoleError = console.error;
  console.error = () => {};
  t.after(() => { console.error = previousConsoleError; });
  const controller = createSubagentController({
    getSession: () => ({
      isAlive: () => true,
      isClosing: () => false,
      isRunning: () => false,
      inner: {
        sessionManager: { getEntries: () => [] },
        sendCustomMessage: () => Promise.reject(new Error("delivery failed")),
      },
    }),
    registerSession: () => {},
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
  });

  controller.flushParentNotifications("parent");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(globalThis.__piSubagentWaves.get("wave").results.size, 1);
  assert.equal(globalThis.__piSubagentNotificationParents.size, 0);
});

test("a rejected notification is not restored after its custom message was recorded", async (t) => {
  const run = completedRun();
  installPendingWave(t, run);
  const entries = [];
  const previousConsoleError = console.error;
  console.error = () => {};
  t.after(() => { console.error = previousConsoleError; });
  const controller = createSubagentController({
    getSession: () => ({
      isAlive: () => true,
      isClosing: () => false,
      isRunning: () => false,
      inner: {
        sessionManager: { getEntries: () => entries },
        sendCustomMessage: (message) => {
          entries.push({ type: "custom_message", customType: message.customType, details: message.details });
          return Promise.reject(new Error("notification run failed"));
        },
      },
    }),
    registerSession: () => {},
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
  });

  controller.flushParentNotifications("parent");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(globalThis.__piSubagentWaves.size, 0);
});

test("an idle parent receives one bounded preview while its notification run is active", async (t) => {
  const run = completedRun({ status: "failed", error: "stream_read_error", result: "x".repeat(10_000) });
  installPendingWave(t, run);
  const sent = [];
  let finishDelivery;
  let parentRunning = false;
  const controller = createSubagentController({
    getSession: () => ({
      isAlive: () => true,
      isClosing: () => false,
      isRunning: () => parentRunning,
      inner: {
        sendCustomMessage: (...args) => {
          sent.push(args);
          parentRunning = true;
          return new Promise((resolve) => {
            finishDelivery = () => {
              parentRunning = false;
              resolve();
            };
          });
        },
      },
    }),
    registerSession: () => {},
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
  });

  assert.equal(controller.flushParentNotifications("parent"), true);
  assert.equal(controller.flushParentNotifications("parent"), false);
  assert.equal(sent.length, 1);
  assert.ok(sent[0][0].content.length <= 6_000);
  assert.match(sent[0][0].content, /Session ID: child/);
  assert.match(sent[0][0].content, /Failure: stream_read_error/);
  assert.ok(sent[0][0].content.indexOf("Failure: stream_read_error") < sent[0][0].content.indexOf("Partial output:"));
  assert.match(sent[0][0].content, /Preview truncated/);
  assert.match(sent[0][0].content, /Use get_subagent_result/);
  assert.deepEqual(sent[0][0].details.results, [{ sessionId: "child", parentToolCallId: "call-1" }]);

  finishDelivery();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
});

test("model-facing result access is scoped to the parent session", async (t) => {
  const previousRuns = globalThis.__piSubagentRuns;
  const run = completedRun();
  globalThis.__piSubagentRuns = new Map([[run.sessionId, { run }]]);
  t.after(() => { globalThis.__piSubagentRuns = previousRuns; });
  const controller = createSubagentController({
    getSession: () => undefined,
    registerSession: () => {},
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
  });

  assert.equal(await controller.extensionRuntime.get("parent", "child"), run);
  await assert.rejects(
    controller.extensionRuntime.get("other-parent", "child"),
    /does not belong to this parent session/,
  );
});

test("a terminal child UI message resumes through the managed runtime", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-ui-resume-"));
  const childPath = join(dir, "child.jsonl");
  await writeFile(childPath, "");
  const previousRuns = globalThis.__piSubagentRuns;
  const previousQueue = globalThis.__piSubagentQueue;
  const previousWaves = globalThis.__piSubagentWaves;
  const previousClaims = globalThis.__piSubagentResumeClaims;
  const previousParents = globalThis.__piSubagentNotificationParents;
  globalThis.__piSubagentRuns = new Map();
  globalThis.__piSubagentQueue = undefined;
  globalThis.__piSubagentWaves = new Map();
  globalThis.__piSubagentResumeClaims = new Set();
  globalThis.__piSubagentNotificationParents = new Set();
  t.after(async () => {
    for (const wave of globalThis.__piSubagentWaves?.values() ?? []) {
      if (wave.notifyTimer) clearTimeout(wave.notifyTimer);
    }
    globalThis.__piSubagentRuns = previousRuns;
    globalThis.__piSubagentQueue = previousQueue;
    globalThis.__piSubagentWaves = previousWaves;
    globalThis.__piSubagentResumeClaims = previousClaims;
    globalThis.__piSubagentNotificationParents = previousParents;
    await rm(dir, { recursive: true, force: true });
  });

  const entries = [
    {
      type: "custom",
      customType: "pi-web:subagent",
      id: "meta",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: {
        version: 1,
        parentSessionId: "parent",
        parentSessionPath: "/tmp/parent.jsonl",
        parentToolCallId: "original-call",
        profile: "general-purpose",
        description: "Continue child",
        task: "Original task",
        runInBackground: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      type: "custom",
      customType: "pi-web:subagent-result",
      id: "result",
      parentId: "meta",
      timestamp: "2026-01-01T00:01:00.000Z",
      data: {
        version: 1,
        status: "completed",
        completedAt: "2026-01-01T00:01:00.000Z",
        result: "Original result",
      },
    },
  ];
  let nextId = 0;
  const manager = {
    getEntries: () => entries,
    appendCustomEntry(customType, data) {
      entries.push({
        type: "custom",
        customType,
        data,
        id: `new-${++nextId}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
      });
    },
  };
  const childInner = {
    sessionManager: manager,
    agent: { state: { messages: [] }, shouldStopAfterTurn: undefined },
    async prompt(task) {
      assert.equal(task, "continue cleanly");
      this.agent.state.messages.push(assistant([{ type: "text", text: "FOLLOWUP" }]));
    },
  };
  const child = {
    sessionFile: childPath,
    inner: childInner,
    isAlive: () => true,
    isClosing: () => false,
    isRunning: () => false,
    waitUntilReady: async () => {},
    shutdown: async () => {},
  };
  let parentRunning = true;
  const parentNotifications = [];
  const parent = {
    sessionFile: "/tmp/parent.jsonl",
    inner: {
      sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
      sendCustomMessage(message) {
        parentNotifications.push(message);
        parentRunning = true;
        return Promise.resolve().finally(() => { parentRunning = false; });
      },
    },
    isAlive: () => true,
    isClosing: () => false,
    isRunning: () => parentRunning,
    waitUntilReady: async () => {},
    shutdown: async () => {},
  };
  const controller = createSubagentController({
    getSession: (id) => id === "child" ? child : id === "parent" ? parent : undefined,
    registerSession: () => {},
    resolveSessionPath: async (id) => id === "child" ? childPath : null,
    invalidateSessionList: () => {},
  });

  const sent = await controller.sendUiMessage("child", "  continue cleanly  ");
  assert.equal(sent.action, "resumed");
  for (let index = 0; index < 10 && !entries.some((entry) => (
    entry.customType === "pi-web:subagent-result" && entry.data?.result === "FOLLOWUP"
  )); index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const resumedMetadata = [...entries].reverse().find((entry) => entry.customType === "pi-web:subagent");
  const resumedResult = [...entries].reverse().find((entry) => entry.customType === "pi-web:subagent-result");
  assert.match(resumedMetadata.data.parentToolCallId, /^ui:/);
  assert.equal(resumedResult.data.status, "completed");
  assert.equal(resumedResult.data.result, "FOLLOWUP");

  parentRunning = false;
  assert.equal(controller.flushParentNotifications("parent"), true);
  assert.equal(parentNotifications.length, 1);
  assert.match(parentNotifications[0].content, /FOLLOWUP/);
});
