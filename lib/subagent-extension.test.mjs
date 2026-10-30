import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";
import { validateToolArguments } from "@earendil-works/pi-ai";

const {
  createSubagentExtension,
  preferPiWebSubagentExtension,
  subagentFinalText,
} = await createJiti(import.meta.url).import("./subagent-extension.ts");

const ONE_PROFILE = [{ name: "explore", description: "Inspect", enabled: true, tools: [] }];

async function loadTools(runtime, getProfiles = () => ONE_PROFILE, isEnabled = () => true) {
  const tools = new Map();
  const sent = [];
  let onToolResult;
  let onBeforeAgentStart;
  const extension = createSubagentExtension(runtime, getProfiles, isEnabled);
  await extension.factory({
    registerTool(tool) { tools.set(tool.name, tool); },
    sendMessage(message, options) { sent.push({ message, options }); },
    on(event, handler) {
      if (event === "tool_result") onToolResult = handler;
      if (event === "before_agent_start") onBeforeAgentStart = handler;
    },
  });
  return { tools, sent, onToolResult, onBeforeAgentStart };
}

function toolResultFlag(onToolResult, toolName, result) {
  return onToolResult({ type: "tool_result", toolName, toolCallId: "call", input: {}, content: result.content, details: result.details, isError: false });
}

function run(overrides = {}) {
  return {
    sessionId: "child-session",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent-session",
    parentToolCallId: "tool-call",
    profile: "explore",
    description: "Find parser",
    task: "Find the parser",
    runInBackground: false,
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const parentEntries = [{
  type: "message",
  message: {
    role: "toolResult",
    details: { kind: "pi-web-subagent", sessionId: "3f4d26b1-1e50-4638-bc28-9da495b6db74", profile: "explore", description: "Audit input" },
  },
}];
const parentContext = { sessionManager: { getSessionId: () => "parent-session", getEntries: () => parentEntries } };

function executeTool(tool, params, signal) {
  return tool.execute("call", params, signal, undefined, parentContext);
}

test("isolated foreground results include recorded cleanup outcomes without raw git advice", async () => {
  for (const cleanup of [
    { worktreeCleanup: "removed" },
    { worktreeCleanup: "removed", worktreeBranch: "saved-work" },
    { worktreeCleanup: "missing" },
    { worktreeCleanup: "kept", worktreePath: "/tmp/kept", worktreeCleanupError: "fatal: use --force to delete it" },
  ]) {
    const finished = run({ status: "completed", result: "Done", ...cleanup });
    const { tools } = await loadTools({
      async start() { return { run: run(), completion: Promise.resolve(finished) }; },
    });
    const result = await executeTool(tools.get("Agent"), { prompt: "test", description: "test", run_in_background: false });
    assert.ok(result.content[0].text.startsWith(subagentFinalText(finished)));
    assert.match(result.content[0].text, cleanup.worktreeCleanup === "kept"
      ? /cleanup failed; checkout kept at \/tmp\/kept\. Automatic cleanup did not complete/
      : cleanup.worktreeCleanup === "missing" ? /checkout already missing; change state unknown.*Check repository branches/
      : cleanup.worktreeBranch ? /changes committed to branch saved-work; checkout removed/ : /no changes; checkout removed/);
    assert.doesNotMatch(result.content[0].text, /--force|fatal:|uncommitted files/);
    for (const status of ["failed", "aborted", "interrupted"]) {
      assert.ok(subagentFinalText({ ...finished, status }).startsWith("[Isolated worktree:"));
    }
  }
  assert.equal(subagentFinalText(run({ status: "completed", result: "Legacy", isolation: "worktree" })), "Legacy");
  assert.equal(subagentFinalText(run({ status: "running", worktreeCleanup: "removed" })), "Subagent child-session is running.");
});

test("integrated extension exposes the legacy-compatible tool names", async () => {
  const tools = new Map();
  const extension = createSubagentExtension({
    async start(request) {
      const running = {
        sessionId: "child-session",
        sessionPath: "/tmp/child.jsonl",
        parentSessionId: "parent-session",
        parentToolCallId: request.parentToolCallId,
        profile: request.profile,
        description: request.description,
        task: request.task,
        runInBackground: true,
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      return {
        run: running,
        completion: Promise.resolve({
          ...running,
          status: "completed",
          completedAt: "2026-01-01T00:01:00.000Z",
          result: "Done",
        }),
      };
    },
    async get() { return null; },
    async steer() {},
  }, () => ONE_PROFILE);
  await extension.factory({
    registerTool(tool) { tools.set(tool.name, tool); },
    sendMessage() {},
    on() {},
  });

  assert.deepEqual([...tools.keys()], ["Agent", "get_subagent_result", "steer_subagent", "abort_subagent"]);
  for (const tool of tools.values()) assert.equal(tool.exposure, "model-only");
  const result = await tools.get("Agent").execute(
    "tool-call",
    {
      subagent_type: "explore",
      prompt: "Find the parser",
      input_files: ["docs/parser.md"],
      description: "Find parser",
      run_in_background: true,
    },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.equal(result.details.kind, "pi-web-subagent");
  assert.equal(result.details.sessionId, "child-session");
});

test("integrated extension registers no tools while its feature is disabled", async () => {
  let enabled = false;
  const runtime = {
    async start() { throw new Error("unused"); },
    async get() { return null; },
    async steer() {},
  };
  let profiles = ONE_PROFILE;
  const extension = createSubagentExtension(runtime, () => profiles, () => enabled);
  const disabledTools = new Map();
  await extension.factory({ registerTool(tool) { disabledTools.set(tool.name, tool); }, on() {} });
  assert.deepEqual([...disabledTools], []);

  enabled = true;
  const enabledTools = new Map();
  await extension.factory({ registerTool(tool) { enabledTools.set(tool.name, tool); }, on() {} });
  assert.deepEqual([...enabledTools.keys()], ["Agent", "get_subagent_result", "steer_subagent", "abort_subagent"]);

  profiles = [{ name: "explore", enabled: false, tools: [] }];
  const noProfileTools = new Map();
  await extension.factory({ registerTool(tool) { noProfileTools.set(tool.name, tool); }, on() {} });
  assert.deepEqual([...noProfileTools], []);
});

test("Agent tool description lists enabled effective profiles and refreshes when its factory reloads", async () => {
  const runtime = {
    async start() { throw new Error("unused"); },
    async get() { return null; },
    async steer() {},
  };
  let profiles = [
    {
      name: "explore",
      displayName: "Explore",
      description: "Inspect the codebase",
      systemPrompt: "Explore",
      tools: ["read", "grep"],
      inheritContext: false,
      runInBackground: false,
      enabled: true,
      scope: "builtin",
    },
    {
      name: "disabled-agent",
      displayName: "Disabled agent",
      description: "Must stay hidden",
      systemPrompt: "Disabled",
      tools: [],
      model: "provider/hidden",
      inheritContext: false,
      runInBackground: false,
      enabled: false,
      scope: "project",
    },
  ];
  const extension = createSubagentExtension(runtime, () => profiles);

  const firstTools = new Map();
  await extension.factory({ registerTool(tool) { firstTools.set(tool.name, tool); }, sendMessage() {}, on() {} });
  const first = firstTools.get("Agent");
  assert.match(first.description, /- explore: Inspect the codebase \(Tools: read, grep; Parent context: none\)/);
  assert.doesNotMatch(first.description, /disabled-agent|Must stay hidden/);
  assert.match(first.parameters.properties.subagent_type.description, /Available types: explore/);

  profiles = [{
    name: "reviewer",
    displayName: "Reviewer",
    description: "Review a change",
    systemPrompt: "Review",
    tools: [],
    model: "provider/review-model",
    thinking: "medium",
    inheritContext: true,
    runInBackground: false,
    enabled: true,
    scope: "project",
  }];
  const reloadedTools = new Map();
  await extension.factory({ registerTool(tool) { reloadedTools.set(tool.name, tool); }, sendMessage() {}, on() {} });
  const reloaded = reloadedTools.get("Agent");
  assert.match(reloaded.description, /- reviewer: Review a change \(Tools: none; Default model: provider\/review-model; Default thinking: medium; Parent context: chat text\)/);
  assert.doesNotMatch(reloaded.description, /explore/);
  assert.match(reloaded.parameters.properties.subagent_type.description, /Available types: reviewer/);
  assert.match(reloaded.parameters.properties.thinking.description, /Omit to use the profile's default thinking/);
});

test("integrated extension removes a legacy extension that owns the same tools", () => {
  const host = {
    path: "<inline:pi-web-subagents>",
    tools: new Map([["Agent", {}], ["get_subagent_result", {}], ["steer_subagent", {}]]),
  };
  const legacy = {
    path: "/tmp/pi-subagents/index.ts",
    tools: new Map([["Agent", {}], ["get_subagent_result", {}], ["steer_subagent", {}]]),
  };
  const other = { path: "/tmp/other.ts", tools: new Map([["search", {}]]) };
  const lookalike = {
    path: "/tmp/unrelated/index.ts",
    tools: new Map([["Agent", {}], ["get_subagent_result", {}], ["steer_subagent", {}], ["custom", {}]]),
  };
  const result = preferPiWebSubagentExtension({
    extensions: [legacy, lookalike, host, other],
    errors: [{ path: legacy.path, error: "duplicate" }, { path: other.path, error: "other" }],
  });

  assert.deepEqual(result.extensions.map((extension) => extension.path), [lookalike.path, host.path, other.path]);
  assert.deepEqual(result.errors.map((error) => error.path), [other.path]);
});

test("integrated extension removes recognized legacy extensions with any reserved tool", () => {
  const host = {
    path: "<inline:pi-web-subagents>",
    tools: new Map([["Agent", {}], ["get_subagent_result", {}], ["steer_subagent", {}]]),
  };
  for (const toolName of ["Agent", "get_subagent_result", "steer_subagent"]) {
    const legacy = {
      path: "/tmp/pi-subagents/index.ts",
      tools: new Map([[toolName, {}], ["other", {}]]),
    };
    const result = preferPiWebSubagentExtension({
      extensions: [legacy, host],
      errors: [{
        path: host.path,
        error: `Tool "${toolName}" conflicts with ${legacy.path}`,
      }],
    });
    assert.deepEqual(result.extensions, [host]);
    assert.deepEqual(result.errors, []);
  }
});

test("foreground Agent streams updates and returns the completed result", async () => {
  const updates = [];
  let request;
  const { tools } = await loadTools({
    async start(value) {
      request = value;
      value.onUpdate(run({ status: "running" }));
      return {
        run: run(),
        completion: Promise.resolve(run({
          status: "completed",
          completedAt: "2026-01-01T00:01:00.000Z",
          result: "Parser is in lib/parser.ts",
        })),
      };
    },
    async get() { return null; },
    async steer() {},
  });
  const result = await tools.get("Agent").execute(
    "tool-call",
    {
      subagent_type: "explore",
      prompt: "Find the parser",
      input_files: ["docs/parser.md"],
      description: "Find parser",
    },
    undefined,
    (update) => updates.push(update),
    { sessionManager: { getSessionId: () => "parent-session" } },
  );

  assert.equal(request.parentToolCallId, "tool-call");
  assert.equal(request.task, "Find the parser");
  assert.deepEqual(request.inputFiles, ["docs/parser.md"]);
  assert.equal(updates[0].details.status, "running");
  assert.equal(result.content[0].text, "Parser is in lib/parser.ts\n\n[Subagent session ID: child-session (pass as resume to continue)]");
  assert.equal(result.details.status, "completed");
  assert.equal(result.isError, undefined);
});

test("foreground Agent reports startup failures as thrown errors and run failures as flagged results", async () => {
  const { tools: startFailureTools } = await loadTools({
    async start() { throw new Error("profile missing"); },
    async get() { return null; },
    async steer() {},
  });
  await assert.rejects(
    startFailureTools.get("Agent").execute(
      "tool-call",
      { prompt: "task", description: "desc" },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "parent-session" } },
    ),
    /profile missing/,
  );

  const { tools: runFailureTools, onToolResult } = await loadTools({
    async start() {
      return {
        run: run(),
        completion: Promise.resolve(run({ status: "failed", error: "model failed" })),
      };
    },
    async get() { return null; },
    async steer() {},
  });
  const result = await runFailureTools.get("Agent").execute(
    "tool-call",
    { prompt: "task", description: "desc" },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.match(result.content[0].text, /model failed/);
  assert.equal(result.details.sessionId, "child-session");
  assert.deepEqual(toolResultFlag(onToolResult, "Agent", result), { isError: true });

  const completed = { content: [], details: { kind: "pi-web-subagent", sessionId: "x", status: "completed" } };
  assert.equal(toolResultFlag(onToolResult, "Agent", completed), undefined);
  const otherTool = { content: [], details: { kind: "pi-web-subagent", sessionId: "x", status: "failed" } };
  assert.equal(toolResultFlag(onToolResult, "steer_subagent", otherTool), undefined);
});

test("background Agent whose start already failed reports the failure instead of a started message", async () => {
  const failed = run({ runInBackground: true, status: "failed", error: "queue full" });
  const consumed = [];
  const { tools, onToolResult } = await loadTools({
    async start() { return { run: failed, completion: Promise.resolve(failed) }; },
    async get() { return null; },
    async steer() {},
    consume(parentSessionId, value) { consumed.push([parentSessionId, value.status]); },
  });
  const result = await executeTool(tools.get("Agent"), { prompt: "task", description: "desc", run_in_background: true });
  assert.match(result.content[0].text, /queue full/);
  assert.deepEqual(consumed, [["parent-session", "failed"]]);
  assert.deepEqual(toolResultFlag(onToolResult, "Agent", result), { isError: true });
});

test("Agent resume routes the prompt to the existing-session runtime", async () => {
  let resumed;
  const { tools } = await loadTools({
    async start() { throw new Error("must use resume"); },
    async resume(request) {
      resumed = request;
      return {
        run: run({ sessionId: "existing", runInBackground: false }),
        completion: Promise.resolve(run({ sessionId: "existing", status: "completed", result: "continued" })),
      };
    },
    async get() { return null; },
    async steer() {},
  });
  const result = await tools.get("Agent").execute(
    "tool-call",
    { resume: "existing", prompt: "Continue the review", description: "Continue review" },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.equal(resumed.sessionId, "existing");
  assert.equal(resumed.task, "Continue the review");
  assert.match(result.content[0].text, /^continued\n\n\[Subagent session ID: existing /);
  await assert.rejects(
    tools.get("Agent").execute("tool-call", { resume: "existing", prompt: "x", description: "x", model: "a/b" }),
    /resume keeps the subagent's model/,
  );
});

test("resume rejects effective create-only options before dispatch but permits empty defaults", async () => {
  const resumed = [];
  const { tools } = await loadTools({
    async start() { throw new Error("must not start"); },
    async resume(request) {
      resumed.push(request);
      const finished = run({ status: "completed", result: "continued" });
      return { run: finished, completion: Promise.resolve(finished) };
    },
  });
  const base = { resume: " existing ", prompt: "Continue", description: "Continue" };
  for (const params of [
    { input_files: ["fact.txt"] }, { isolation: "worktree" }, { model: "a/b" }, { thinking: "high" },
  ]) {
    await assert.rejects(executeTool(tools.get("Agent"), { ...base, ...params }), /resume/);
  }
  assert.equal(resumed.length, 0);
  await executeTool(tools.get("Agent"), {
    ...base, input_files: [], isolation: "", model: "", thinking: "", run_in_background: false,
  });
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].sessionId, "existing");
  assert.equal(resumed[0].runInBackground, false);
});

test("retired max_turns and inherit_context keys still validate and are ignored", async () => {
  const started = [];
  const resumed = [];
  const { tools } = await loadTools({
    async start(request) {
      started.push(request);
      const finished = run({ status: "completed", result: "ok" });
      return { run: finished, completion: Promise.resolve(finished) };
    },
    async resume(request) {
      resumed.push(request);
      const finished = run({ status: "completed", result: "ok" });
      return { run: finished, completion: Promise.resolve(finished) };
    },
  });
  const tool = tools.get("Agent");
  assert.equal("max_turns" in tool.parameters.properties, false);
  assert.equal("inherit_context" in tool.parameters.properties, false);

  // pi's agent loop validates arguments before execute(); undeclared keys pass through and are ignored.
  const legacy = { subagent_type: "explore", prompt: "Find the parser", description: "Find parser", max_turns: 8, inherit_context: true };
  await executeTool(tool, validateToolArguments(tool, { name: "Agent", arguments: legacy }));
  assert.equal(started.length, 1);
  assert.equal("maxTurns" in started[0], false);
  assert.equal("inheritContext" in started[0], false);

  await executeTool(tool, validateToolArguments(tool, {
    name: "Agent", arguments: { resume: "existing", prompt: "Continue", description: "Continue", max_turns: 1, inherit_context: true },
  }));
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].sessionId, "existing");
});

test("background Agent returns immediately without triggering a parent continuation", async () => {
  let finish;
  const completion = new Promise((resolve) => { finish = resolve; });
  const { tools, sent } = await loadTools({
    async start() {
      return { run: run({ runInBackground: true }), completion };
    },
    async get() { return null; },
    async steer() {},
  });
  const result = await tools.get("Agent").execute(
    "tool-call",
    { prompt: "task", description: "desc", run_in_background: true },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "parent-session" } },
  );
  assert.match(result.content[0].text, /started in background/);
  assert.match(result.content[0].text, /delivered automatically/);
  assert.equal(sent.length, 0);

  finish(run({ runInBackground: true, status: "completed", result: "done" }));
  await completion;
  await Promise.resolve();
  assert.equal(sent.length, 0);
});

test("get_subagent_result covers missing, running, completed, failed, and aborted runs", async () => {
  let current = null;
  const consumed = [];
  const { tools, onToolResult } = await loadTools({
    async start() { throw new Error("unused"); },
    async get() { return current; },
    async steer() {},
    consume(parentSessionId, value) { consumed.push([parentSessionId, value.status]); },
  });
  const tool = tools.get("get_subagent_result");

  await assert.rejects(
    executeTool(tool, { agent_id: "3f4d26b1-1e50-4636-bc28-9da495b6db74" }),
    /not found: 3f4d26b1-1e50-4636-bc28-9da495b6db74[\s\S]*- 3f4d26b1-1e50-4638-bc28-9da495b6db74: Audit input \(explore\)/,
  );

  current = run();
  let result = await executeTool(tool, { agent_id: "child-session" });
  assert.equal(result.details.status, "running");
  assert.equal(result.content[0].text, "Subagent child-session is running.");
  assert.deepEqual(consumed, []);

  current = run({ status: "completed", result: "done" });
  result = await executeTool(tool, { agent_id: "child-session" });
  assert.equal(result.content[0].text, "done");

  current = run({ status: "completed", result: "done", wrappedAtTurnLimit: true });
  result = await executeTool(tool, { agent_id: "child-session" });
  assert.match(result.content[0].text, /done[\s\S]*wrapped up after reaching its turn limit/);
  assert.equal(result.details.wrappedAtTurnLimit, true);

  current = run({ status: "failed", error: "boom" });
  result = await executeTool(tool, { agent_id: "child-session" });
  assert.match(result.content[0].text, /boom/);
  assert.deepEqual(toolResultFlag(onToolResult, "get_subagent_result", result), { isError: true });

  current = run({ status: "failed", error: "boom", result: "partial" });
  result = await executeTool(tool, { agent_id: "child-session" });
  assert.match(result.content[0].text, /partial[\s\S]*boom/);

  current = run({ status: "aborted", result: "partial" });
  result = await executeTool(tool, { agent_id: "child-session" });
  assert.match(result.content[0].text, /partial[\s\S]*was stopped/);

  current = run({ status: "interrupted" });
  result = await executeTool(tool, { agent_id: "child-session" });
  assert.match(result.content[0].text, /interrupted before completion/);
  assert.deepEqual(consumed, [
    ["parent-session", "completed"],
    ["parent-session", "completed"],
    ["parent-session", "failed"],
    ["parent-session", "failed"],
    ["parent-session", "aborted"],
    ["parent-session", "interrupted"],
  ]);
});

test("foreground Agent yields after timeout_ms and delegates its eventual report", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = Promise.withResolvers();
  t.after(() => pending.resolve(run({ status: "completed" })));
  let deferred = 0;
  const { tools } = await loadTools({
    start: async () => ({ run: run(), completion: pending.promise, deferResult: () => { deferred++; } }),
  });
  let result;
  const waiting = executeTool(tools.get("Agent"), { prompt: "task", description: "task", run_in_background: false, timeout_ms: 10 }).then((value) => { result = value; });
  await new Promise(setImmediate);
  t.mock.timers.tick(10);
  await new Promise(setImmediate);
  assert.ok(result, "foreground wait must return while the child remains pending");
  assert.equal(deferred, 1);
  assert.equal(result.details.status, "running");
  assert.match(result.content[0].text, /continues.*automatically/);
  await waiting;
});

test("get_subagent_result budgets even its first lookup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lookup = Promise.withResolvers();
  t.after(() => lookup.resolve(run()));
  const { tools } = await loadTools({ get: () => lookup.promise });
  let result;
  const waiting = executeTool(tools.get("get_subagent_result"), { agent_id: "child-session", wait: true, timeout_ms: 10 }).then((value) => { result = value; });
  await new Promise(setImmediate);
  t.mock.timers.tick(10);
  await new Promise(setImmediate);
  assert.ok(result, "first runtime.get must not escape the wait budget");
  assert.match(result.content[0].text, /10ms/);
  await waiting;
});

test("both wait schemas keep the millisecond bounds without a seconds-based alternative", async () => {
  const { tools } = await loadTools({});
  for (const name of ["Agent", "get_subagent_result"]) {
    const tool = tools.get(name);
    assert.equal(tool.parameters.properties.timeout_ms.minimum, 1);
    assert.equal(tool.parameters.properties.timeout_ms.maximum, 1_800_000);
    assert.equal("wait_timeout" in tool.parameters.properties, false);
    const required = name === "Agent" ? { prompt: "task", description: "task" } : { agent_id: "child" };
    for (const timeout_ms of [0, -1, 1_800_001]) {
      assert.throws(() => validateToolArguments(tool, { name, arguments: { ...required, timeout_ms } }));
    }
  }
});

test("later result lookups share the original deadline and timeout leaves the result unread", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const lookup = Promise.withResolvers();
  const controller = new AbortController();
  let reads = 0;
  let consumed = 0;
  const { tools } = await loadTools({
    get: async () => ++reads === 1 ? run() : lookup.promise,
    consume: () => { consumed++; },
  });
  let result;
  const waiting = executeTool(tools.get("get_subagent_result"), { agent_id: "child-session", wait: true, timeout_ms: 1000 }, controller.signal).then((value) => { result = value; });
  await new Promise(setImmediate);
  t.mock.timers.tick(500);
  await new Promise(setImmediate);
  assert.equal(reads, 2);
  t.mock.timers.tick(499);
  await new Promise(setImmediate);
  assert.equal(result, undefined);
  t.mock.timers.tick(1);
  await waiting;
  assert.match(result.content[0].text, /still running after waiting 1000ms/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  lookup.resolve(run({ status: "completed" }));
  await new Promise(setImmediate);
  assert.equal(consumed, 0);
  assert.equal(reads, 2);
});

test("aborting a stalled first result lookup returns promptly and removes listeners", async () => {
  const controller = new AbortController();
  const lookup = Promise.withResolvers();
  const { tools } = await loadTools({ get: () => lookup.promise });
  const waiting = executeTool(tools.get("get_subagent_result"), { agent_id: "child-session", wait: true }, controller.signal);
  controller.abort();
  await assert.rejects(waiting, /Result wait aborted/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  lookup.reject(new Error("late lookup failure"));
  await new Promise(setImmediate);
});

test("get_subagent_result wait honors abort signals", async () => {
  const { tools } = await loadTools({
    async start() { throw new Error("unused"); },
    async get() { return run(); },
    async steer() {},
    consume() {},
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeTool(tools.get("get_subagent_result"), { agent_id: "child-session", wait: true }, controller.signal),
    /Result wait aborted/,
  );
});

test("get_subagent_result wait returns a running snapshot after its timeout", async () => {
  const { tools } = await loadTools({
    async start() { throw new Error("unused"); },
    async get() { return run(); },
    async steer() {},
    consume() {},
  });

  const result = await executeTool(
    tools.get("get_subagent_result"),
    { agent_id: "child-session", wait: true, timeout_ms: 5 },
  );
  assert.equal(result.details.status, "running");
  assert.match(result.content[0].text, /still running after waiting 5ms/);
});

test("steer_subagent returns success and runtime failures", async () => {
  const calls = [];
  const { tools } = await loadTools({
    async start() { throw new Error("unused"); },
    async get() { return null; },
    async steer(parentSessionId, id, message) {
      calls.push([parentSessionId, id, message]);
      if (message === "fail") throw new Error("not running");
    },
    consume() {},
  });
  const tool = tools.get("steer_subagent");
  const success = await executeTool(tool, { agent_id: "child-session", message: "focus" });
  assert.deepEqual(calls[0], ["parent-session", "child-session", "focus"]);
  assert.match(success.content[0].text, /sent/);

  await assert.rejects(
    executeTool(tool, { agent_id: "child-session", message: "fail" }),
    /not running/,
  );
});

test("legacy preference leaves unrelated and partial-overlap extensions intact", () => {
  const host = { path: "<inline:pi-web-subagents>", tools: new Map() };
  const partial = { path: "/tmp/partial.ts", tools: new Map([["Agent", {}]]) };
  const base = { extensions: [host, partial], errors: [] };
  assert.equal(preferPiWebSubagentExtension(base), base);

  const noHost = { extensions: [partial], errors: [] };
  assert.equal(preferPiWebSubagentExtension(noHost), noHost);
});

test("abort_subagent stops a run without a second completion notice, and reports one already settled", async () => {
  const consumed = [];
  let next = { run: run({ status: "aborted", runInBackground: true }), alreadySettled: false };
  const { tools } = await loadTools({
    async abort(parentSessionId, id) { assert.deepEqual([parentSessionId, id], ["parent-session", "child-session"]); return next; },
    consume(parentSessionId, value) { consumed.push([parentSessionId, value.status]); },
  });
  const tool = tools.get("abort_subagent");
  const stopped = await executeTool(tool, { agent_id: "child-session" });
  assert.match(stopped.content[0].text, /stopped \(aborted\)\. Read its transcript with get_subagent_result or continue it with Agent resume/);
  assert.equal(stopped.details.sessionId, "child-session");
  assert.deepEqual(consumed, [["parent-session", "aborted"]]);

  next = { run: run({ status: "aborted" }), alreadySettled: true };
  assert.match((await executeTool(tool, { agent_id: "child-session" })).content[0].text, /already aborted; nothing to stop/);

  next = { run: run({ status: "running" }), alreadySettled: false };
  assert.match((await executeTool(tool, { agent_id: "child-session" })).content[0].text, /Stop requested .* still running\. Its result will be delivered/);
  assert.equal(consumed.length, 2);
});

test("the delegation policy rides in its own prompt section and names enabled profiles", async () => {
  const profiles = [
    { name: "explore", enabled: true, tools: [] },
    { name: "plan", enabled: false, tools: [] },
    { name: "reviewer", enabled: true, tools: [] },
  ];
  const { tools, onBeforeAgentStart } = await loadTools({}, () => profiles);
  assert.equal(tools.get("Agent").promptGuidelines, undefined);
  const ctx = { scopedModels: [], modelRegistry: { getAvailable: () => [] } };
  const active = { systemPromptOptions: { selectedTools: ["Agent"], sections: {} } };
  onBeforeAgentStart(active, ctx);
  const section = active.systemPromptOptions.sections.delegation;
  assert.match(section, /^- Agent runs a task in a fresh session that does not see this conversation/);
  assert.match(section, /`explore`: broad questions/);
  assert.doesNotMatch(section, /`plan`/);
  assert.match(section, /Other subagents: `reviewer`\./);
  assert.match(section, /non-overlapping files, or with isolation/);
  assert.doesNotMatch(section, /whenever possible/i);
  const inactive = { systemPromptOptions: { selectedTools: ["read"], sections: {} } };
  onBeforeAgentStart(inactive, ctx);
  assert.equal(inactive.systemPromptOptions.sections.delegation, undefined);
});

test("lists usable subagent models in the prompt only while Agent is active", async () => {
  const { onBeforeAgentStart } = await loadTools({});
  const opus = { provider: "claude", id: "claude-opus-5-5", name: "Opus 5.5" };
  const ctx = { scopedModels: [{ model: opus }], modelRegistry: { getAvailable: () => [opus, { provider: "x", id: "y" }] } };
  const active = { systemPromptOptions: { selectedTools: ["Agent"], sections: {} } };
  onBeforeAgentStart(active, ctx);
  assert.match(active.systemPromptOptions.sections.subagent_models, /- claude\/claude-opus-5-5 \(Opus 5\.5\)/);
  assert.doesNotMatch(active.systemPromptOptions.sections.subagent_models, /x\/y/);
  const inactive = { systemPromptOptions: { selectedTools: ["read"], sections: {} } };
  onBeforeAgentStart(inactive, ctx);
  assert.equal(inactive.systemPromptOptions.sections.subagent_models, undefined);
});
