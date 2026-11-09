import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { routineInputFromToolParams, routineConfirmMessage, createRoutineToolExtension, ROUTINE_TOOL_NAME, LIST_ROUTINES_TOOL_NAME, UPDATE_ROUTINE_TOOL_NAME } = await jiti.import("./routine-tool-extension.ts");
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

test("update_routine: changes name, instructions, schedule or on/off at once; never where it runs", async (t) => {
  const { dir, store } = tempStore(t);
  const pi = fakePi();
  pi.setActiveTools(["read", "bash"]);
  createRoutineToolExtension(() => store).factory(pi);
  const update = pi.tools.find((item) => item.name === UPDATE_ROUTINE_TOOL_NAME);
  const list = pi.tools.find((item) => item.name === LIST_ROUTINES_TOOL_NAME);
  assert.equal(update.exposure, "deferred");
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => "chat-1", getEntries: () => [] } };
  const routine = await store.create(routineInputFromToolParams({ name: "Scan", instructions: "Scan Asia", run_in: "this_chat", cron: "0 * * * *" }, { ...chat, cwd: dir }));

  const changed = await update.execute("u1", { id: routine.id, instructions: "Scan Europe", cron: "0 9 * * *", target: { kind: "new_session" } }, undefined, undefined, ctx);
  assert.deepEqual(changed.details, { updated: true, routineId: routine.id, name: "Scan" });
  assert.match(changed.content[0].text, /instructions replaced; schedule: Every hour at :00 → Every day at 09:00 AM/);
  const [saved] = store.list();
  assert.equal(saved.prompt, "Scan Europe");
  assert.deepEqual(saved.target, routine.target);

  const paused = await update.execute("u2", { id: routine.id, enabled: false }, undefined, undefined, ctx);
  assert.match(paused.content[0].text, /paused\. Next run: none \(paused\)/);
  const same = await update.execute("u3", { id: routine.id, enabled: false }, undefined, undefined, ctx);
  assert.equal(same.details.updated, false);

  // Blank optional fields (some models send every field) mean unchanged.
  const blanks = await update.execute("u3b", { id: routine.id, name: "", instructions: "", cron: "0 8-23 * * *", at: "", enabled: false }, undefined, undefined, ctx);
  assert.match(blanks.content[0].text, /^Updated routine "Scan": schedule: /);
  assert.equal(store.list()[0].prompt, "Scan Europe");

  const invalid = await update.execute("u4", { id: routine.id, cron: "* * * * *" }, undefined, undefined, ctx);
  assert.match(invalid.content[0].text, /^Not updated: .*5 minutes/);
  assert.match((await update.execute("u5", { id: "nope", name: "x" }, undefined, undefined, ctx)).content[0].text, /no routine nope/);

  // Another project's routines are neither listed nor changed.
  const other = tempStore(t).dir;
  const elsewhere = { ...ctx, cwd: other };
  assert.match((await update.execute("u6", { id: routine.id, name: "x" }, undefined, undefined, elsewhere)).content[0].text, /no routine/);
  assert.match((await list.execute("l0", {}, undefined, undefined, elsewhere)).content[0].text, /^No routines in this project/);

  // The read-only preset cannot rewrite unattended work without approval.
  pi.setActiveTools(["read"]);
  assert.match((await update.execute("u7", { id: routine.id, name: "x" }, undefined, undefined, ctx)).content[0].text, /read-only/);
});

test("list_routines: one line each; with id the instructions and recent runs", async (t) => {
  const { dir, store } = tempStore(t);
  const pi = fakePi();
  createRoutineToolExtension(() => store).factory(pi);
  const list = pi.tools.find((item) => item.name === LIST_ROUTINES_TOOL_NAME);
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => "chat-1", getEntries: () => [] } };
  const routine = await store.create(routineInputFromToolParams({ name: "Scan", instructions: "Scan Europe", run_in: "this_chat", cron: "0 * * * *" }, { ...chat, cwd: dir }));
  const { run } = await store.claimManualRun(routine.id);
  await store.updateRun(routine.id, run.runId, { status: "failed", error: "boom", finishedAt: new Date().toISOString() });

  const short = (await list.execute("l1", {}, undefined, undefined, ctx)).content[0].text;
  assert.match(short, new RegExp(`^- ${routine.id} "Scan" · on · Every hour at :00 · next .* · runs in this chat · last run: manual run, started .*, failed: boom`));
  assert.doesNotMatch(short, /Scan Europe/);
  const full = (await list.execute("l2", { id: routine.id }, undefined, undefined, ctx)).content[0].text;
  assert.match(full, /Instructions:\nScan Europe\nRecent runs, newest first:\n- manual run/);
});
