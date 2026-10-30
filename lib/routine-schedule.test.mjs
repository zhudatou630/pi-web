import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { draftFromSchedule, scheduleFromDraft, previewRuns, defaultScheduleDraft, nextRuns, latestRun, firesTooOften, LAST_DAY } =
  await createJiti(import.meta.url).import("./routine-schedule.ts");

const TZ = "Asia/Shanghai";
const local = (text) => new Date(`${text}+08:00`); // wall time in TZ
const iso = (dates) => dates.map((date) => date.toISOString());
const base = defaultScheduleDraft();
const nine = [{ hour: 9, minute: 0 }];

test("form presets round-trip through the stored schedule", () => {
  for (const [draft, exprs] of [
    [{ ...base, preset: "hourly", minute: 15, unit: "hour" }, ["15 * * * *"]],
    [{ ...base, preset: "daily", times: [{ hour: 7, minute: 5 }], unit: "day" }, ["5 7 * * *"]],
    [{ ...base, preset: "weekdays", unit: "week" }, ["0 9 * * 1-5"]],
    [{ ...base, preset: "weekly", weekdays: [1, 3, 0], times: [{ hour: 18, minute: 30 }], unit: "week" }, ["30 18 * * 1,3,0"]],
    [{ ...base, preset: "monthly", monthDays: [1, 15, LAST_DAY], unit: "month" }, ["0 9 1,15,L * *"]],
    // 9:00 and 18:00 share a minute; 12:30 needs its own expression.
    [{ ...base, preset: "daily", times: [{ hour: 9, minute: 0 }, { hour: 12, minute: 30 }, { hour: 18, minute: 0 }], unit: "day" }, ["0 9,18 * * *", "30 12 * * *"]],
  ]) {
    const stored = scheduleFromDraft(draft);
    assert.deepEqual(stored, { kind: "cron", exprs }, draft.preset);
    assert.deepEqual(draftFromSchedule(stored), { ...draft, cron: exprs.join("\n") }, draft.preset);
  }
  assert.deepEqual(draftFromSchedule({ kind: "manual" }), { ...base, preset: "manual" });

  const custom = { ...base, preset: "custom", unit: "week", every: 2, weekdays: [1], endsAt: "2026-12-31", anchor: "2026-11-02T01:00:00.000Z" };
  const stored = scheduleFromDraft(custom);
  assert.deepEqual(stored, { kind: "cron", exprs: ["0 9 * * 1"], repeat: { every: 2, unit: "week", anchor: custom.anchor }, endsAt: "2026-12-31" });
  assert.deepEqual(draftFromSchedule(stored), { ...custom, cron: "0 9 * * 1" });
});

test("steps that divide the hour or day are plain cron and read back as custom", () => {
  assert.deepEqual(scheduleFromDraft({ ...base, preset: "custom", unit: "minute", every: 30 }), { kind: "cron", exprs: ["*/30 * * * *"] });
  assert.deepEqual(scheduleFromDraft({ ...base, preset: "custom", unit: "hour", every: 6, minute: 30 }), { kind: "cron", exprs: ["30 */6 * * *"] });
  assert.deepEqual(draftFromSchedule({ kind: "cron", exprs: ["*/30 * * * *"] }), { ...base, preset: "custom", unit: "minute", every: 30, cron: "*/30 * * * *" });
  assert.deepEqual(draftFromSchedule({ kind: "cron", exprs: ["30 */6 * * *"] }), { ...base, preset: "custom", unit: "hour", every: 6, minute: 30, cron: "30 */6 * * *" });
});

test("a stored minute or hour rhythm keeps its anchor through the form even when the step divides", () => {
  for (const schedule of [
    { kind: "cron", exprs: ["* * * * *"], repeat: { every: 30, unit: "minute", anchor: "2026-11-01T00:10:00.000Z" } },
    { kind: "cron", exprs: ["0 * * * *"], repeat: { every: 6, unit: "hour", anchor: "2026-11-01T01:00:00.000Z" } },
  ]) assert.deepEqual(scheduleFromDraft(draftFromSchedule(schedule)), schedule);
});

test("expressions the form cannot show stay raw cron, keeping a stored rhythm", () => {
  for (const exprs of [["*/7 9-17 * * *"], ["0 9 1 1 *"], ["0 9 1-7 * 1"], ["0 25 * * *"], ["0 9 * * *", "0 9 * * 1"]]) {
    assert.equal(draftFromSchedule({ kind: "cron", exprs }).preset, "cron", exprs.join(" | "));
  }
  const repeat = { every: 2, unit: "day", anchor: "2026-11-01T01:00:00.000Z" };
  const raw = draftFromSchedule({ kind: "cron", exprs: ["0 9-17/2 * * *"], repeat });
  assert.deepEqual(scheduleFromDraft(raw), { kind: "cron", exprs: ["0 9-17/2 * * *"], repeat });
  assert.deepEqual(scheduleFromDraft({ ...base, preset: "cron", cron: " 0  9 * * 1 \n\n30 18 * * 1" }), { kind: "cron", exprs: ["0 9 * * 1", "30 18 * * 1"] });
});

test("every N periods: days, weeks and months count from the first slot after creation", () => {
  // Created Wednesday 2026-11-04 10:00 for "every 2 weeks on Monday 09:00": the first Monday runs.
  const weekly = scheduleFromDraft({ ...base, preset: "custom", unit: "week", every: 2, weekdays: [1] }, TZ, local("2026-11-04T10:00:00"));
  assert.equal(weekly.repeat.anchor, local("2026-11-09T09:00:00").toISOString());
  assert.deepEqual(iso(nextRuns(weekly, TZ, 3, local("2026-11-04T10:00:00"))),
    iso([local("2026-11-09T09:00:00"), local("2026-11-23T09:00:00"), local("2026-12-07T09:00:00")]));

  const days = scheduleFromDraft({ ...base, preset: "custom", unit: "day", every: 3, times: [{ hour: 8, minute: 0 }] }, TZ, local("2026-11-30T09:00:00"));
  assert.deepEqual(iso(nextRuns(days, TZ, 3, local("2026-11-30T09:00:00"))),
    iso([local("2026-12-01T08:00:00"), local("2026-12-04T08:00:00"), local("2026-12-07T08:00:00")]));

  const months = scheduleFromDraft({ ...base, preset: "custom", unit: "month", every: 2, monthDays: [15], times: nine }, TZ, local("2026-11-20T00:00:00"));
  assert.deepEqual(iso(nextRuns(months, TZ, 2, local("2026-11-20T00:00:00"))),
    iso([local("2026-12-15T09:00:00"), local("2027-02-15T09:00:00")]));
});

test("every N minutes or hours that do not divide evenly count from midnight", () => {
  const now = local("2026-11-02T10:07:00");
  const minutes = scheduleFromDraft({ ...base, preset: "custom", unit: "minute", every: 45 }, TZ, now);
  assert.deepEqual(minutes, { kind: "cron", exprs: ["* * * * *"], repeat: { every: 45, unit: "minute", anchor: local("2026-11-02T00:00:00").toISOString() } });
  // 00:00, 00:45, ... 09:45, 10:30
  assert.deepEqual(iso(nextRuns(minutes, TZ, 3, now)), iso([local("2026-11-02T10:30:00"), local("2026-11-02T11:15:00"), local("2026-11-02T12:00:00")]));
  assert.equal(latestRun(minutes, TZ, now, local("2026-11-01T00:00:00")).toISOString(), local("2026-11-02T09:45:00").toISOString());
  assert.equal(latestRun(minutes, TZ, now, local("2026-11-02T09:45:00")), null);
  assert.equal(firesTooOften(minutes, 15 * 60_000, TZ, now), false);
  const tenMinutes = scheduleFromDraft({ ...base, preset: "custom", unit: "minute", every: 10 }, TZ, now);
  assert.equal(firesTooOften(tenMinutes, 15 * 60_000, TZ, now), true);
  assert.equal(firesTooOften(tenMinutes, 5 * 60_000, TZ, now), false);

  // Created at 00:10, before today's 00:30: the phase still starts today, not yesterday.
  const early = scheduleFromDraft({ ...base, preset: "custom", unit: "hour", every: 5, minute: 30 }, TZ, local("2026-11-02T00:10:00"));
  assert.equal(early.repeat.anchor, local("2026-11-02T00:30:00").toISOString());
  assert.deepEqual(iso(nextRuns(early, TZ, 2, local("2026-11-02T00:10:00"))), iso([local("2026-11-02T00:30:00"), local("2026-11-02T05:30:00")]));
  assert.equal(scheduleFromDraft({ ...base, preset: "custom", unit: "minute", every: 45 }, TZ, local("2026-11-02T00:00:00")).repeat.anchor,
    local("2026-11-02T00:00:00").toISOString());

  const hours = scheduleFromDraft({ ...base, preset: "custom", unit: "hour", every: 5, minute: 30 }, TZ, local("2026-11-01T22:40:00"));
  assert.equal(hours.repeat.anchor, local("2026-11-01T00:30:00").toISOString());
  // 00:30, 05:30, ..., 20:30, then 01:30 the next day: the count does not restart at midnight.
  assert.deepEqual(iso(nextRuns(hours, TZ, 3, local("2026-11-01T22:40:00"))),
    iso([local("2026-11-02T01:30:00"), local("2026-11-02T06:30:00"), local("2026-11-02T11:30:00")]));
});

test("an end date is inclusive and latestRun honours rhythm and end", () => {
  const schedule = { kind: "cron", exprs: ["0 9 * * *"], repeat: { every: 2, unit: "day", anchor: local("2026-11-01T09:00:00").toISOString() }, endsAt: "2026-11-05" };
  assert.deepEqual(iso(nextRuns(schedule, TZ, 10, local("2026-10-31T00:00:00"))),
    iso([local("2026-11-01T09:00:00"), local("2026-11-03T09:00:00"), local("2026-11-05T09:00:00")]));
  assert.equal(latestRun(schedule, TZ, local("2026-11-04T12:00:00"), local("2026-10-01T00:00:00")).toISOString(), local("2026-11-03T09:00:00").toISOString());
  assert.equal(latestRun(schedule, TZ, local("2026-11-04T12:00:00"), local("2026-11-03T09:00:00")), null);
  assert.equal(latestRun(schedule, TZ, local("2026-11-09T12:00:00"), local("2026-10-01T00:00:00")).toISOString(), local("2026-11-05T09:00:00").toISOString());

  const minutes = { kind: "cron", exprs: ["* * * * *"], repeat: { every: 30 * 24, unit: "minute", anchor: local("2026-11-01T00:00:00").toISOString() }, endsAt: "2026-11-01" };
  assert.deepEqual(iso(nextRuns(minutes, TZ, 5, local("2026-10-31T00:00:00"))), iso([local("2026-11-01T00:00:00"), local("2026-11-01T12:00:00")]));
  assert.equal(latestRun(minutes, TZ, local("2026-11-03T00:00:00"), local("2026-10-01T00:00:00")).toISOString(), local("2026-11-01T12:00:00").toISOString());
});

test("several expressions fire at the union of their slots", () => {
  const schedule = { kind: "cron", exprs: ["0 9,18 * * *", "30 12 * * *"] };
  assert.deepEqual(iso(nextRuns(schedule, TZ, 4, local("2026-11-02T08:00:00"))),
    iso([local("2026-11-02T09:00:00"), local("2026-11-02T12:30:00"), local("2026-11-02T18:00:00"), local("2026-11-03T09:00:00")]));
  assert.equal(latestRun(schedule, TZ, local("2026-11-02T13:00:00"), local("2026-11-01T00:00:00")).toISOString(), local("2026-11-02T12:30:00").toISOString());
  assert.deepEqual(iso(nextRuns({ kind: "cron", exprs: ["0 9 L * *"] }, TZ, 2, local("2026-11-02T00:00:00"))),
    iso([local("2026-11-30T09:00:00"), local("2026-12-31T09:00:00")]));
});

test("preview uses the server's zone and reports a bad expression", () => {
  const shanghai = previewRuns({ kind: "cron", exprs: ["0 9 * * *"] }, TZ, 1, new Date("2026-11-02T00:00:00Z"));
  assert.equal(shanghai.runs[0].toISOString(), "2026-11-02T01:00:00.000Z");
  const newYork = previewRuns({ kind: "cron", exprs: ["0 9 * * *"] }, "America/New_York", 2, new Date("2026-10-31T00:00:00Z"));
  assert.deepEqual(iso(newYork.runs), ["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z"]);
  assert.match(previewRuns({ kind: "cron", exprs: ["nope"] }).error, /./);
  assert.equal(previewRuns({ kind: "cron", exprs: ["0 9 * * *", "10 9 * * *"] }).tooOften, true);
  assert.deepEqual(previewRuns({ kind: "manual" }), { runs: [], tooOften: false });
});

test("a one-time run fires once at its wall time in the server's zone", () => {
  const draft = { ...base, preset: "once", onceDate: "2026-11-03", times: [{ hour: 15, minute: 5 }] };
  const once = scheduleFromDraft(draft);
  assert.deepEqual(once, { kind: "once", at: "2026-11-03T15:05" });
  assert.deepEqual(draftFromSchedule(once), draft);
  assert.deepEqual(iso(nextRuns(once, TZ, 3, local("2026-11-02T00:00:00"))), iso([local("2026-11-03T15:05:00")]));
  assert.deepEqual(nextRuns(once, TZ, 3, local("2026-11-03T15:05:00")), []);
  assert.equal(latestRun(once, TZ, local("2026-11-04T00:00:00"), local("2026-11-01T00:00:00")).toISOString(), local("2026-11-03T15:05:00").toISOString());
  assert.equal(latestRun(once, TZ, local("2026-11-04T00:00:00"), local("2026-11-03T15:05:00")), null);
  // A wall time skipped by DST runs right after the gap (03:30 EDT), as croner does for cron.
  assert.deepEqual(iso(nextRuns({ kind: "once", at: "2027-03-14T02:30" }, "America/New_York", 1, new Date("2027-01-01T00:00:00Z"))), ["2027-03-14T07:30:00.000Z"]);
});
