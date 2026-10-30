import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { routineInputFromToolParams, routineConfirmMessage, createRoutineToolExtension, ROUTINE_TOOL_NAME } = await jiti.import("./routine-tool-extension.ts");
const { RoutineStore } = await jiti.import("./routines.ts");

const chat = {
  sessionId: "chat-1",
  cwd: "/tmp",
  model: { provider: "claude", modelId: "opus" },
  thinkingLevel: "high",
  toolNames: ["read", "grep"],
};
const now = new Date("2026-11-02T10:00:00");

test("a new chat each run copies this chat's model and tools; this chat keeps its own", () => {
  const daily = routineInputFromToolParams({ name: "Digest", instructions: "Summarize", run_in: "new_chat", cron: "0 9 * * 1-5" }, chat);
  assert.deepEqual(daily.target, { kind: "new_session", cwd: "/tmp", toolNames: ["read", "grep"], model: chat.model, thinkingLevel: "high" });
  assert.deepEqual(daily.schedule, { kind: "cron", exprs: ["0 9 * * 1-5"] });

  const here = routineInputFromToolParams({ name: "Watch PR", instructions: "Check", run_in: "this_chat", cron: "*/10 * * * *" }, chat);
  assert.deepEqual(here.target, { kind: "same_session", cwd: "/tmp", sessionId: "chat-1" });
});

test("schedules: one cron or one time, with the form's validation", () => {
  const make = (schedule, run_in = "new_chat") => routineInputFromToolParams({ name: "n", instructions: "p", run_in, ...schedule }, chat);
  assert.deepEqual(make({ at: "2099-01-01T15:00" }).schedule, { kind: "once", at: "2099-01-01T15:00" });
  assert.throws(() => make({}), /exactly one/);
  assert.throws(() => make({ at: "2099-01-01T15:00", cron: "0 9 * * *" }), /exactly one/);
  assert.throws(() => make({ cron: "*/10 * * * *" }), /15 minutes/);
  assert.throws(() => make({ at: "2000-01-01T09:00" }), /never runs/);
});

test("the confirmation card: the schedule in words, the next run, where it runs, the instructions", () => {
  const input = routineInputFromToolParams({ name: "Digest", instructions: "Summarize yesterday", run_in: "new_chat", cron: "0 9 * * 1-5" }, chat);
  assert.equal(routineConfirmMessage(input, now), [
    "**Every weekday at 09:00 AM** · next Tue, Nov 3, 9:00 AM (in 23 h)",
    "",
    "Each run starts a new chat.",
    "",
    "> Summarize yesterday",
  ].join("\n"));
  const here = routineInputFromToolParams({ name: "Watch", instructions: "Check", run_in: "this_chat", cron: "*/30 * * * *" }, chat);
  assert.match(routineConfirmMessage(here, now, false), /^\*\*Every 30 minutes\*\* · next Mon, Nov 2, 10:30 AM \(in 30 min\)\n\nEach run continues this chat\.\n\n_Scheduling is off/);
});

/** The slice of ExtensionAPI the extension uses. */
function fakePi({ withToolSearch = true } = {}) {
  const handlers = {};
  const tools = withToolSearch ? [{ name: "tool_search", reachesTools: () => "all" }] : [];
  let active = ["read"];
  return {
    tools, handlers,
    get active() { return active; },
    on: (event, handler) => { handlers[event] = handler; },
    registerTool: (tool) => tools.push(tool),
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: (names) => { active = names; },
    getThinkingLevel: () => "medium",
  };
}

/** A store in a temp dir, so the user's own routines file (and its on/off switch) never leaks in. */
function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "routine-tool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new RoutineStore({ path: join(dir, "routines.json") }) };
}

test("the tool is deferred and reachable through tool_search with a one-line hint", (t) => {
  const { store } = tempStore(t);
  const pi = fakePi();
  createRoutineToolExtension(() => store).factory(pi);
  const tool = pi.tools.find((item) => item.name === ROUTINE_TOOL_NAME);
  assert.equal(tool.exposure, "deferred");
  pi.handlers.session_start();
  assert.deepEqual(pi.active, ["read", "tool_search"]);
  const event = { systemPromptOptions: { selectedTools: pi.active, sections: {} } };
  pi.handlers.before_agent_start(event);
  assert.match(event.systemPromptOptions.sections.routines, /create_routine/);

  // Without Pi Web's tool-search (disabled builtin) nothing is activated or announced.
  const bare = fakePi({ withToolSearch: false });
  createRoutineToolExtension(() => store).factory(bare);
  bare.handlers.session_start();
  assert.deepEqual(bare.active, ["read"]);
  const quiet = { systemPromptOptions: { selectedTools: bare.active, sections: {} } };
  bare.handlers.before_agent_start(quiet);
  assert.deepEqual(quiet.systemPromptOptions.sections, {});
});

test("nothing is saved unless the user confirms", async (t) => {
  const { dir, store } = tempStore(t);
  const pi = fakePi();
  createRoutineToolExtension(() => store).factory(pi);
  const tool = pi.tools.find((item) => item.name === ROUTINE_TOOL_NAME);
  let answer = false;
  const ctx = {
    cwd: dir,
    model: { provider: "claude", id: "opus" },
    sessionManager: { getSessionId: () => "chat-1", getEntries: () => [] },
    ui: { confirm: async () => answer },
  };
  const params = { name: "Digest", instructions: "Summarize", run_in: "new_chat", cron: "0 9 * * *" };
  const declined = await tool.execute("call-1", params, undefined, undefined, ctx);
  assert.equal(declined.details.created, false);
  assert.deepEqual(store.list(), []);

  answer = true;
  const created = await tool.execute("call-2", params, undefined, undefined, ctx);
  assert.equal(created.details.created, true);
  assert.deepEqual(store.list().map((routine) => [routine.name, routine.target.kind, routine.target.model]), [["Digest", "new_session", { provider: "claude", modelId: "opus" }]]);
  assert.match(created.content[0].text, /^Created routine "Digest"\. Next run: /);
  assert.match(declined.content[0].text, /Server time now:/);
});

test("switched off in Settings: no tool, no tool_search, and an already loaded tool refuses", async (t) => {
  const { dir, store } = tempStore(t);
  const loaded = fakePi();
  createRoutineToolExtension(() => store).factory(loaded);
  await store.setFeatureEnabled(false);

  const pi = fakePi();
  createRoutineToolExtension(() => store).factory(pi);
  assert.equal(pi.tools.some((item) => item.name === ROUTINE_TOOL_NAME), false);
  assert.equal(pi.handlers.session_start, undefined);

  const tool = loaded.tools.find((item) => item.name === ROUTINE_TOOL_NAME);
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => "chat-1", getEntries: () => [] }, ui: { confirm: async () => true } };
  const result = await tool.execute("call-1", { name: "Digest", instructions: "Summarize", run_in: "new_chat", cron: "0 9 * * *" }, undefined, undefined, ctx);
  assert.equal(result.details.created, false);
  assert.match(result.content[0].text, /turned off/);
  assert.deepEqual(store.list(), []);
});
