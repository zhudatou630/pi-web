import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  advanceSubagentTurnLimit,
  buildParentContextText,
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
