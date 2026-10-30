import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { RoutineStore, parseRoutineInput, dueOccurrence, nextRunAt, MAX_RUNS } =
  await createJiti(import.meta.url).import("./routines.ts");

function fixture(t, isPidAlive = () => true) {
  const dir = mkdtempSync(join(tmpdir(), "routines-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new RoutineStore({ path: join(dir, "routines.json"), isPidAlive });
}

const input = (overrides = {}) => parseRoutineInput({
  name: "Daily digest",
  prompt: "Summarize yesterday",
  schedule: { kind: "cron", exprs: ["0 9 * * *"] },
  target: { kind: "new_session", cwd: "/tmp" },
  ...overrides,
});

const at = (text) => new Date(text);

test("input validation fills defaults and rejects bad schedules, targets and frequent cron", () => {
  const parsed = input();
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.timeoutMinutes, 30);
  assert.deepEqual(parsed.target, { kind: "new_session", cwd: "/tmp" });
  assert.deepEqual(input({ schedule: { kind: "cron", exprs: [" 0  9 * * 1-5 ", "0 9 * * 1-5", "30 18 * * 1-5"] } }).schedule, { kind: "cron", exprs: ["0 9 * * 1-5", "30 18 * * 1-5"] });
  assert.throws(() => input({ schedule: { kind: "cron", exprs: [] } }), /exprs/);
  assert.throws(() => input({ schedule: { kind: "cron", exprs: ["0 9 * * *", "5 9 * * *"] } }), /15 minutes/);
  assert.throws(() => input({ schedule: { kind: "cron", exprs: ["0 9 * * *"], repeat: { every: 45, unit: "minute", anchor: "2026-11-01T00:00:00Z" } } }), /minute repeat/);
  assert.doesNotThrow(() => input({ schedule: { kind: "cron", exprs: ["* * * * *"], repeat: { every: 45, unit: "minute", anchor: "2026-11-01T00:00:00Z" } } }));
  assert.throws(() => input({ schedule: { kind: "cron", exprs: ["* * * * *"], repeat: { every: 10, unit: "minute", anchor: "2026-11-01T00:00:00Z" } } }), /15 minutes/);
  assert.throws(() => input({ schedule: { kind: "cron", exprs: ["0 0 9 * * *"] } }), /Invalid cron/);
  assert.throws(() => input({ schedule: { kind: "cron", exprs: ["*/5 * * * *"] } }), /15 minutes/);
  assert.doesNotThrow(() => input({ schedule: { kind: "cron", exprs: ["*/15 * * * *"] } }));
  assert.throws(() => input({ target: { kind: "new_session", cwd: "relative" } }), /absolute/);
  assert.throws(() => input({ target: { kind: "existing_session", sessionId: "x" } }), /same_session/);
  // One continuing chat: an optional chat id, and a shorter minimum gap (5 minutes, not 15).
  assert.deepEqual(input({ target: { kind: "same_session", cwd: "/tmp", sessionId: "abc-123" } }).target, { kind: "same_session", cwd: "/tmp", sessionId: "abc-123" });
  assert.throws(() => input({ target: { kind: "same_session", cwd: "/tmp", sessionId: "../x" } }), /sessionId/);
  assert.throws(() => input({ schedule: { kind: "cron", exprs: ["*/10 * * * *"] } }), /15 minutes/);
  assert.doesNotThrow(() => input({ schedule: { kind: "cron", exprs: ["*/10 * * * *"] }, target: { kind: "same_session", cwd: "/tmp" } }));
  assert.throws(() => input({ schedule: { kind: "cron", exprs: ["*/2 * * * *"] }, target: { kind: "same_session", cwd: "/tmp" } }), /5 minutes/);
  assert.throws(() => input({ target: { kind: "new_session", cwd: "/tmp", toolNames: ["nope"] } }));
  assert.throws(() => input({ target: { kind: "new_session", cwd: "/tmp", thinkingLevel: "auto" } }), /thinkingLevel/);
  assert.throws(() => input({ name: "" }), /name/);
  assert.throws(() => input({ schedule: { kind: "cron", exprs: ["61 * * * *"] } }), /Invalid cron/);
  assert.throws(() => input({ schedule: { kind: "cron", exprs: ["0 9 * * *"], endsAt: "2000-01-01" } }), /never runs/);
  assert.throws(() => input({ schedule: { kind: "cron", exprs: ["0 9 * * *"], repeat: { every: 0, unit: "day", anchor: "2026-11-01T00:00:00Z" } } }), /repeat/);
  assert.deepEqual(input({ schedule: { kind: "cron", exprs: ["0 9 * * *"], repeat: { every: 2, unit: "day", anchor: "2026-11-01T01:00:00Z" } } }).schedule.repeat,
    { every: 2, unit: "day", anchor: "2026-11-01T01:00:00.000Z" });
});

test("due occurrence fires once, catches up only the newest miss within 7 days, and respects pause/manual", () => {
  const routine = { ...input(), lastScheduledFor: at("2026-11-02T08:00:00").toISOString(), runs: [] };
  assert.equal(dueOccurrence(routine, at("2026-11-02T08:59:00")), null);
  const onTime = dueOccurrence(routine, at("2026-11-02T09:00:20"));
  assert.equal(onTime.scheduledFor.getTime(), at("2026-11-02T09:00:00").getTime());
  assert.equal(onTime.catchUp, false);
  assert.equal(dueOccurrence({ ...routine, lastScheduledFor: onTime.scheduledFor.toISOString() }, at("2026-11-02T09:00:50")), null);

  const missed = dueOccurrence(routine, at("2026-11-05T15:00:00"));
  assert.equal(missed.scheduledFor.getTime(), at("2026-11-05T09:00:00").getTime());
  assert.equal(missed.catchUp, true);
  // Beyond the window: the newest occurrence is still within 7 days, older ones are gone.
  assert.equal(dueOccurrence(routine, at("2026-12-01T08:00:00")).scheduledFor.getTime(), at("2026-11-30T09:00:00").getTime());

  assert.equal(dueOccurrence({ ...routine, enabled: false }, at("2026-11-05T15:00:00")), null);
  assert.equal(dueOccurrence({ ...routine, schedule: { kind: "manual" } }, at("2026-11-05T15:00:00")), null);
  assert.equal(nextRunAt(routine, at("2026-11-02T09:00:00")).getTime(), at("2026-11-03T09:00:00").getTime());
  assert.equal(nextRunAt({ ...routine, enabled: false }, at("2026-11-02T09:00:00")), null);
});

test("claims are single-shot, skip overlaps and the concurrency limit, and keep history bounded", async (t) => {
  const store = fixture(t);
  const created = at("2026-11-02T08:00:00");
  await store.create(input({ name: "a" }), created);
  await store.create(input({ name: "b" }), created);
  await store.create(input({ name: "c" }), created);

  const nine = at("2026-11-02T09:00:10");
  const [first, second] = (await Promise.all([store.claimDueRuns(nine), store.claimDueRuns(nine)])).map((claimed) => claimed.started);
  assert.equal(first.length + second.length, 2, "two started, never duplicated");
  const runs = store.list().flatMap((routine) => routine.runs);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((run) => run.skipReason).filter(Boolean), ["concurrency_limit"]);

  const [started] = [...first, ...second];
  const tomorrow = at("2026-11-03T09:00:10");
  const { started: next, skipped } = await store.claimDueRuns(tomorrow);
  // Both earlier runs still go: both overlap; the third is over the concurrency limit.
  assert.deepEqual(skipped.map(({ run }) => run.skipReason).sort(), ["concurrency_limit", "previous_running", "previous_running"]);
  const overlap = store.list().find((routine) => routine.id === started.routine.id).runs[0];
  assert.equal(overlap.skipReason, "previous_running");
  assert.ok(next.every(({ routine }) => routine.id !== started.routine.id));

  await store.updateRun(started.routine.id, started.run.runId, { status: "succeeded", finishedAt: tomorrow.toISOString() });
  const done = store.list().find((routine) => routine.id === started.routine.id).runs.find((run) => run.runId === started.run.runId);
  assert.equal(done.status, "succeeded");
  assert.equal(done.pid, undefined);

  const manual = await store.claimManualRun(started.routine.id);
  assert.equal(manual.run.trigger, "manual");
  await assert.rejects(store.claimManualRun(manual.routine.id), (error) => error.status === 409);

  for (let i = 0; i < MAX_RUNS + 5; i++) {
    await store.updateRun(manual.routine.id, manual.run.runId, { status: "succeeded" });
    await store.claimManualRun(manual.routine.id).then(({ run }) => { manual.run = run; });
  }
  assert.equal(store.list().find((routine) => routine.id === manual.routine.id).runs.length, MAX_RUNS);
});

test("trimming history never drops a run that is still going", async (t) => {
  const store = fixture(t);
  const created = at("2026-11-02T08:00:00");
  const routine = await store.create(input({ schedule: { kind: "cron", exprs: ["*/15 * * * *"] }, timeoutMinutes: 720 }), created);
  let now = created.getTime();
  for (let i = 0; i < MAX_RUNS + 3; i++) {
    now += 15 * 60_000;
    await store.claimDueRuns(new Date(now + 10_000));
  }
  const runs = store.list().find((item) => item.id === routine.id).runs;
  assert.equal(runs.length, MAX_RUNS);
  assert.equal(runs.filter((run) => run.status === "running").length, 1, "the first run is kept");
  assert.equal(runs.at(-1).status, "running");
});

test("switched off, nothing fires or runs by hand; back on, schedules restart from now", async (t) => {
  const store = fixture(t);
  const routine = await store.create(input(), at("2026-11-02T08:00:00"));
  await store.setFeatureEnabled(false);
  assert.equal(store.isFeatureEnabled(), false);
  assert.deepEqual(await store.claimDueRuns(at("2026-11-02T09:00:10")), { started: [], skipped: [] });
  await assert.rejects(store.claimManualRun(routine.id), (error) => error.status === 409);

  await store.setFeatureEnabled(true, at("2026-11-04T12:00:00"));
  assert.equal(store.isFeatureEnabled(), true);
  // The 9:00 runs missed while off are not caught up.
  assert.deepEqual(await store.claimDueRuns(at("2026-11-04T12:00:10")), { started: [], skipped: [] });
  assert.equal((await store.claimDueRuns(at("2026-11-05T09:00:10"))).started.length, 1);
});

test("runs owned by a dead process read as interrupted and no longer block", async (t) => {
  let alive = true;
  const store = fixture(t, () => alive);
  const routine = await store.create(input());
  await store.claimManualRun(routine.id);
  alive = false;
  assert.equal(store.list()[0].runs[0].status, "failed");
  assert.match(store.list()[0].runs[0].error, /Interrupted/);
  await store.claimManualRun(routine.id);
});

test("updates keep cwd fixed and restart scheduling from now on resume or reschedule", async (t) => {
  const store = fixture(t);
  const routine = await store.create(input({ enabled: false }), at("2026-11-01T00:00:00"));
  await assert.rejects(store.update(routine.id, input({ target: { kind: "new_session", cwd: "/var" } })), /cannot be changed/);
  const resumedAt = at("2026-11-05T12:00:00");
  const resumed = await store.update(routine.id, input(), resumedAt);
  assert.equal(resumed.lastScheduledFor, resumedAt.toISOString());
  assert.equal(dueOccurrence(resumed, at("2026-11-05T12:01:00")), null, "no catch-up for the paused days");
  await assert.rejects(store.update("missing", input()), (error) => error.status === 404);
  await store.remove(routine.id);
  assert.deepEqual(store.list(), []);
});

test("a corrupt file is never overwritten", async (t) => {
  const store = fixture(t);
  writeFileSync(store.path, "{not json");
  await assert.rejects(store.create(input()), /Corrupt routines file/);
  assert.equal(readFileSync(store.path, "utf8"), "{not json");
});

test("manual runs do not use up the scheduled concurrency slots", async (t) => {
  const store = fixture(t);
  const created = new Date("2026-11-02T08:00:00");
  const manualA = await store.create(input({ name: "m1", schedule: { kind: "manual" } }), created);
  const manualB = await store.create(input({ name: "m2", schedule: { kind: "manual" } }), created);
  await store.create(input({ name: "scheduled" }), created);
  await store.claimManualRun(manualA.id);
  await store.claimManualRun(manualB.id);
  const { started } = await store.claimDueRuns(new Date("2026-11-02T09:00:10"));
  assert.deepEqual(started.map(({ routine }) => routine.name), ["scheduled"]);
});

test("a continuing routine binds the chat its first run created, once, and can be paused", async (t) => {
  const store = fixture(t);
  const routine = await store.create(input({ target: { kind: "same_session", cwd: "/tmp" } }));
  await store.bindSession(routine.id, "first");
  await store.bindSession(routine.id, "second");
  assert.deepEqual(store.list()[0].target, { kind: "same_session", cwd: "/tmp", sessionId: "first" });
  await store.pause(routine.id);
  assert.equal(store.list()[0].enabled, false);
  // Switching the mode keeps the project; another project is still refused.
  await store.update(routine.id, input({ enabled: false }));
  assert.equal(store.list()[0].target.kind, "new_session");
  await assert.rejects(store.update(routine.id, input({ target: { kind: "same_session", cwd: "/var" } })), /cannot be changed/);
});

test("saving a form loaded before the first run keeps the chat that run bound", async (t) => {
  const store = fixture(t);
  const stale = input({ target: { kind: "same_session", cwd: "/tmp" } });
  const routine = await store.create(stale);
  await store.bindSession(routine.id, "bound");
  await store.update(routine.id, { ...stale, prompt: "edited" });
  assert.equal(store.list()[0].target.sessionId, "bound");
  await store.update(routine.id, input({ target: { kind: "same_session", cwd: "/tmp", sessionId: "other" } }));
  assert.equal(store.list()[0].target.sessionId, "other");
});

test("a one-time routine pauses once its occurrence is claimed and can still be edited", async (t) => {
  const store = fixture(t);
  const routine = await store.create(input({ schedule: { kind: "once", at: "2099-01-01T09:00" } }), at("2026-11-01T00:00:00"));
  const [claimed] = (await store.claimDueRuns(at("2099-01-01T09:00:10"))).started;
  assert.equal(claimed.routine.id, routine.id);
  assert.equal(store.list()[0].enabled, false);
  assert.deepEqual(await store.claimDueRuns(at("2099-01-01T09:30:00")), { started: [], skipped: [] });
  assert.throws(() => input({ schedule: { kind: "once", at: "2000-01-01T09:00" } }), /never runs/);
  assert.doesNotThrow(() => input({ enabled: false, schedule: { kind: "once", at: "2000-01-01T09:00" } }));
  assert.throws(() => input({ schedule: { kind: "once", at: "2099-02-30T09:00" } }), /schedule.at/);
});

test("a routine whose schedule cannot be computed does not block the others", async (t) => {
  const store = fixture(t);
  const created = new Date("2026-11-02T08:00:00");
  const broken = await store.create(input({ name: "broken" }), created);
  await store.create(input({ name: "fine" }), created);
  const file = JSON.parse(readFileSync(store.path, "utf8"));
  file.routines.find((routine) => routine.id === broken.id).schedule = { kind: "cron", exprs: ["not a cron"] };
  writeFileSync(store.path, JSON.stringify(file));
  const errors = t.mock.method(console, "error", () => {});
  const { started } = await store.claimDueRuns(new Date("2026-11-02T09:00:10"));
  assert.deepEqual(started.map(({ routine }) => routine.name), ["fine"]);
  assert.equal(errors.mock.callCount(), 1);
});

test("a worktree per run is for new chats only", () => {
  assert.equal(input({ target: { kind: "new_session", cwd: "/tmp", worktree: true } }).target.worktree, true);
  assert.equal(input({ target: { kind: "new_session", cwd: "/tmp", worktree: false } }).target.worktree, undefined);
  assert.throws(() => input({ target: { kind: "same_session", cwd: "/tmp", worktree: true } }), /new_session routines only/);
  assert.throws(() => input({ target: { kind: "new_session", cwd: "/tmp", worktree: "yes" } }), /boolean/);
});
