import { Cron } from "croner";

// Routine schedules (docs/routines.md). Shared by the server (firing) and the form
// (summary + preview), so both compute occurrences the same way.

export type RepeatUnit = "minute" | "hour" | "day" | "week" | "month";
export type RepeatSpec = { every: number; unit: RepeatUnit; anchor: string };

/**
 * Stored schedule. `exprs` (5-field cron, server-local time; a slot fires when any matches)
 * give the slots within one period; `repeat` keeps only every Nth period counted from
 * `anchor` ("every 2 weeks"), which plain cron cannot say; `endsAt` (YYYY-MM-DD,
 * inclusive) stops it. Several expressions exist because "9:30 and 18:00" is not one cron.
 */
export type RoutineSchedule =
  | { kind: "manual" }
  /** One run at `at`, server-local wall time "YYYY-MM-DDTHH:mm"; the routine pauses once it fires. */
  | { kind: "once"; at: string }
  | { kind: "cron"; exprs: string[]; repeat?: RepeatSpec; endsAt?: string };

/** Form presets. "cron" edits the expressions directly. */
export type SchedulePreset = "manual" | "once" | "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom" | "cron";

export interface ClockTime { hour: number; minute: number }

export interface ScheduleDraft {
  preset: SchedulePreset;
  /** day/week/month units: one or more times of day */
  times: ClockTime[];
  /** hour unit: minute past the hour */
  minute: number;
  /** 0 = Sunday */
  weekdays: number[];
  /** 1-31, or LAST_DAY */
  monthDays: number[];
  /** custom: every N units */
  every: number;
  unit: RepeatUnit;
  /** custom and cron: YYYY-MM-DD (possibly half typed), or null for never */
  endsAt: string | null;
  /** once: YYYY-MM-DD (possibly half typed); the time is times[0] */
  onceDate: string;
  /** Kept from the stored schedule so editing does not shift an "every N" rhythm. */
  anchor: string | null;
  /** cron preset: one expression per line */
  cron: string;
  /** A stored rhythm on expressions the form cannot show (API-written); kept, not dropped. */
  cronRepeat: RepeatSpec | null;
}

export const SCHEDULE_PRESETS: readonly SchedulePreset[] = ["manual", "once", "hourly", "daily", "weekdays", "weekly", "monthly", "custom", "cron"];
export const REPEAT_UNITS: readonly RepeatUnit[] = ["minute", "hour", "day", "week", "month"];
export const MAX_EVERY = 999;
export const MAX_EXPRS = 8;
/** Month day meaning "the last day of the month" (cron `L`). */
export const LAST_DAY = 32;
/**
 * Shortest gap between runs. A new chat each run floods the sidebar and pays a full start
 * every time, so 15 minutes; one continuing chat creates nothing new, so 5.
 */
export function minIntervalMs(targetKind: "new_session" | "same_session"): number {
  return (targetKind === "same_session" ? 5 : 15) * 60_000;
}

export function defaultScheduleDraft(): ScheduleDraft {
  return {
    preset: "weekdays", times: [{ hour: 9, minute: 0 }], minute: 0, weekdays: [1, 2, 3, 4, 5], monthDays: [1],
    every: 1, unit: "day", endsAt: null, onceDate: "", anchor: null, cron: "0 9 * * 1-5", cronRepeat: null,
  };
}

const sortedDays = (days: readonly number[]) => [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
const sortedNumbers = (values: readonly number[]) => [...new Set(values)].sort((a, b) => a - b);
export const sortedTimes = (times: readonly ClockTime[]): ClockTime[] =>
  sortedNumbers(times.map((time) => time.hour * 60 + time.minute)).map((value) => ({ hour: Math.floor(value / 60), minute: value % 60 }));
export const normalizeExpr = (expr: string) => expr.trim().replace(/\s+/g, " ");

// ---------- form <-> cron ----------

type FormShape = Pick<ScheduleDraft, "preset" | "unit" | "every"> & Partial<Pick<ScheduleDraft, "times" | "minute" | "weekdays" | "monthDays">>;

/** What the form can show for these expressions (without repeat), or null. */
function formFromExprs(exprs: readonly string[]): FormShape | null {
  const parsed = exprs.map((expr) => expr.split(" "));
  if (parsed.length === 0 || parsed.some((fields) => fields.length !== 5 || fields[3] !== "*")) return null;
  const num = (text: string, min: number, max: number) => (/^\d{1,2}$/.test(text) && Number(text) >= min && Number(text) <= max ? Number(text) : null);
  const step = (text: string, divides: number) => {
    const match = /^\*\/(\d{1,2})$/.exec(text);
    return match && Number(match[1]) > 1 && Number(match[1]) < divides && divides % Number(match[1]) === 0 ? Number(match[1]) : null;
  };

  if (parsed.length === 1) {
    const [m, h, dom, , dow] = parsed[0];
    if (dom === "*" && dow === "*") {
      if (h === "*" && m === "*") return { preset: "custom", unit: "minute", every: 1 };
      const minuteStep = step(m, 60);
      if (h === "*" && minuteStep) return { preset: "custom", unit: "minute", every: minuteStep };
      const minute = num(m, 0, 59);
      if (minute !== null && h === "*") return { preset: "hourly", unit: "hour", every: 1, minute };
      const hourStep = step(h, 24);
      if (minute !== null && hourStep) return { preset: "custom", unit: "hour", every: hourStep, minute };
    }
  }

  // Times of day: every expression is "M H[,H...] dom * dow" with the same dom and dow.
  const [, , dom, , dow] = parsed[0];
  if (parsed.some((fields) => fields[2] !== dom || fields[4] !== dow)) return null;
  const times: ClockTime[] = [];
  for (const [m, h] of parsed) {
    const minute = num(m, 0, 59);
    const hours = h.split(",").map((hour) => num(hour, 0, 23));
    if (minute === null || hours.some((hour) => hour === null)) return null;
    for (const hour of hours) times.push({ hour: hour!, minute });
  }
  const shape = { times: sortedTimes(times), every: 1 };
  if (dom === "*" && dow === "*") return { ...shape, preset: "daily", unit: "day" };
  if (dom === "*" && dow === "1-5") return { ...shape, preset: "weekdays", unit: "week", weekdays: [1, 2, 3, 4, 5] };
  if (dom === "*") {
    const days = dow.split(",").map((day) => num(day, 0, 6));
    return days.some((day) => day === null) ? null : { ...shape, preset: "weekly", unit: "week", weekdays: sortedDays(days as number[]) };
  }
  if (dow === "*") {
    const days = dom.split(",").map((day) => (day === "L" ? LAST_DAY : num(day, 1, 31)));
    return days.some((day) => day === null) ? null : { ...shape, preset: "monthly", unit: "month", monthDays: sortedNumbers(days as number[]) };
  }
  return null;
}

/** Reads a stored schedule back into the form that produced it; anything else is raw "cron". */
export function draftFromSchedule(schedule: RoutineSchedule): ScheduleDraft {
  const base = defaultScheduleDraft();
  if (schedule.kind === "manual") return { ...base, preset: "manual" };
  if (schedule.kind === "once") {
    const [date, clock] = schedule.at.split("T");
    const [hour, minute] = clock.split(":").map(Number);
    return { ...base, preset: "once", onceDate: date, times: [{ hour, minute }] };
  }
  const cron = schedule.exprs.join("\n");
  const raw: ScheduleDraft = { ...base, preset: "cron", cron, endsAt: schedule.endsAt ?? null, cronRepeat: schedule.repeat ?? null };
  const form = formFromExprs(schedule.exprs);
  if (!form) return raw;
  const { repeat } = schedule;
  // A step written into the cron (*/30) cannot also carry a repeat; a minute repeat needs "* * * * *".
  if (repeat && (form.every !== 1 || repeat.unit !== form.unit || (repeat.unit === "minute" && schedule.exprs[0] !== "* * * * *"))) return raw;
  const every = repeat?.every ?? form.every;
  const custom = every > 1 || Boolean(schedule.endsAt) || form.unit === "minute";
  return {
    ...base, ...form, cron,
    preset: custom ? "custom" : form.preset,
    every, endsAt: schedule.endsAt ?? null, anchor: repeat?.anchor ?? null,
  };
}

const weekdayField = (days: readonly number[]) => (days.length ? sortedDays(days).join(",") : "1");
const monthDayField = (days: readonly number[]) => (days.length ? sortedNumbers(days).map((day) => (day === LAST_DAY ? "L" : day)).join(",") : "1");

/** One expression per distinct minute: 9:00 and 18:00 share "0 9,18"; 9:30 needs its own. */
function timeExprs(times: readonly ClockTime[], dom: string, dow: string): string[] {
  const byMinute = new Map<number, number[]>();
  for (const { hour, minute } of sortedTimes(times.length ? times : [{ hour: 9, minute: 0 }])) {
    byMinute.set(minute, [...(byMinute.get(minute) ?? []), hour]);
  }
  return [...byMinute].sort(([a], [b]) => a - b).map(([minute, hours]) => `${minute} ${hours.join(",")} ${dom} * ${dow}`);
}

/** Expressions for one period of `unit`, and how many periods `repeat` must still skip. */
function exprsFor(draft: ScheduleDraft, unit: RepeatUnit, every: number): { exprs: string[]; repeatEvery: number } {
  switch (unit) {
    // Steps that divide the hour/day are plain cron (*/30, */6); others count from midnight.
    case "minute":
      if (every === 1) return { exprs: ["* * * * *"], repeatEvery: 1 };
      return 60 % every === 0 && every < 60 ? { exprs: [`*/${every} * * * *`], repeatEvery: 1 } : { exprs: ["* * * * *"], repeatEvery: every };
    case "hour":
      if (every > 1 && every < 24 && 24 % every === 0) return { exprs: [`${draft.minute} */${every} * * *`], repeatEvery: 1 };
      return { exprs: [`${draft.minute} * * * *`], repeatEvery: every };
    case "day": return { exprs: timeExprs(draft.times, "*", "*"), repeatEvery: every };
    case "week": return { exprs: timeExprs(draft.times, "*", weekdayField(draft.weekdays)), repeatEvery: every };
    case "month": return { exprs: timeExprs(draft.times, monthDayField(draft.monthDays), "*"), repeatEvery: every };
  }
}

const cronOptions = (timeZone: string | undefined) => ({ mode: "5-part" as const, paused: true, ...(timeZone ? { timezone: timeZone } : {}) });

/**
 * A new rhythm's anchor, in the server's `timeZone`. Minutes and hours count from midnight
 * (every 45 minutes = 00:00, 00:45, ...); days, weeks and months from the first slot after
 * `now`, so the next matching slot always runs.
 */
export function newAnchor(unit: RepeatUnit, exprs: readonly string[], minute: number, timeZone: string | undefined, now: Date): string {
  if (unit === "minute" || unit === "hour") {
    // Today's midnight (croner looks strictly before, to the second, so +1 s keeps exactly
    // midnight as today), then the minute offset: the previous "30 0 * * *" at 00:10 would be
    // yesterday's and shift the whole phase.
    const midnight = new Cron("0 0 * * *", cronOptions(timeZone)).previousRuns(1, new Date(now.getTime() + 1000))[0] ?? now;
    return new Date(midnight.getTime() + (unit === "hour" ? minute * 60_000 : 0)).toISOString();
  }
  const first = exprs.map((expr) => new Cron(expr, cronOptions(timeZone)).nextRun(now)).filter((date): date is Date => date !== null);
  return (first.length ? new Date(Math.min(...first.map((date) => date.getTime()))) : now).toISOString();
}

export function scheduleFromDraft(draft: ScheduleDraft, timeZone?: string, now = new Date()): RoutineSchedule {
  const ends = draft.endsAt ? { endsAt: draft.endsAt } : {};
  switch (draft.preset) {
    case "manual": return { kind: "manual" };
    case "once": {
      const { hour, minute } = draft.times[0] ?? { hour: 9, minute: 0 };
      return { kind: "once", at: `${draft.onceDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
    }
    case "cron": return {
      kind: "cron",
      exprs: [...new Set(draft.cron.split("\n").map(normalizeExpr).filter(Boolean))],
      ...(draft.cronRepeat ? { repeat: draft.cronRepeat } : {}),
      ...ends,
    };
    case "hourly": return { kind: "cron", exprs: exprsFor(draft, "hour", 1).exprs };
    case "daily": return { kind: "cron", exprs: exprsFor(draft, "day", 1).exprs };
    case "weekdays": return { kind: "cron", exprs: timeExprs(draft.times, "*", "1-5") };
    case "weekly": return { kind: "cron", exprs: exprsFor(draft, "week", 1).exprs };
    case "monthly": return { kind: "cron", exprs: exprsFor(draft, "month", 1).exprs };
    case "custom": {
      const every = Math.max(1, Math.min(MAX_EVERY, Math.floor(draft.every) || 1));
      // A stored minute/hour rhythm keeps counting from its anchor even when the step divides
      // the hour or day: `*/N` would move an API-written phase (00:10, 00:40) to midnight's.
      const keepsAnchor = draft.anchor !== null && every > 1 && (draft.unit === "minute" || draft.unit === "hour");
      const { exprs, repeatEvery } = keepsAnchor
        ? { exprs: [draft.unit === "minute" ? "* * * * *" : `${draft.minute} * * * *`], repeatEvery: every }
        : exprsFor(draft, draft.unit, every);
      return {
        kind: "cron",
        exprs,
        ...(repeatEvery > 1 ? { repeat: { every: repeatEvery, unit: draft.unit, anchor: draft.anchor ?? newAnchor(draft.unit, exprs, draft.minute, timeZone, now) } } : {}),
        ...ends,
      };
    }
  }
}

// ---------- occurrences ----------

/** Calendar fields of `date` in `timeZone` (server-local when undefined). */
function zoned(date: Date, timeZone: string | undefined) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

const dayNumber = (date: Date, timeZone: string | undefined) => {
  const { year, month, day } = zoned(date, timeZone);
  return Date.UTC(year, month - 1, day) / 86_400_000;
};

const dateKey = (date: Date, timeZone: string | undefined) => {
  const { year, month, day } = zoned(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

/** Periods between the anchor's and `date`'s, in the repeat unit (weeks start Monday). */
function periodIndex(date: Date, repeat: RepeatSpec, timeZone: string | undefined): number {
  const anchor = new Date(repeat.anchor);
  switch (repeat.unit) {
    case "minute": return Math.floor(date.getTime() / 60_000) - Math.floor(anchor.getTime() / 60_000);
    case "hour": return Math.floor(date.getTime() / 3_600_000) - Math.floor(anchor.getTime() / 3_600_000);
    case "day": return dayNumber(date, timeZone) - dayNumber(anchor, timeZone);
    // Epoch day 0 was a Thursday; +3 makes weeks run Monday..Sunday.
    case "week": return Math.floor((dayNumber(date, timeZone) + 3) / 7) - Math.floor((dayNumber(anchor, timeZone) + 3) / 7);
    case "month": {
      const a = zoned(anchor, timeZone);
      const d = zoned(date, timeZone);
      return (d.year * 12 + d.month) - (a.year * 12 + a.month);
    }
  }
}

type CronSchedule = Extract<RoutineSchedule, { kind: "cron" }>;

/** "YYYY-MM-DDTHH:mm" with real calendar fields. */
export function isOnceAt(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour <= 23 && minute <= 59;
}

/** The instant of a one-time run's wall time in `timeZone` (a DST-skipped time runs just after the gap). */
function onceInstant(at: string, timeZone: string | undefined): Date | null {
  if (!isOnceAt(at)) return null;
  const [year, month, day, hour, minute] = at.split(/[-T:]/).map(Number);
  // That wall time recurs yearly; take the occurrence that starts from a day before it.
  const run = new Cron(`${minute} ${hour} ${day} ${month} *`, cronOptions(timeZone)).nextRun(new Date(Date.UTC(year, month - 1, day) - 2 * 86_400_000));
  return run && dateKey(run, timeZone) === at.slice(0, 10) ? run : null;
}

const ended = (schedule: CronSchedule, date: Date, timeZone: string | undefined) =>
  Boolean(schedule.endsAt) && dateKey(date, timeZone) > schedule.endsAt!;

function keeps(schedule: CronSchedule, date: Date, timeZone: string | undefined): boolean {
  if (!schedule.repeat) return true;
  const index = periodIndex(date, schedule.repeat, timeZone);
  return index >= 0 && index % schedule.repeat.every === 0;
}

/** Any expression's next slot after `after` / latest slot before `before`. */
function slots(schedule: CronSchedule, timeZone: string | undefined) {
  const jobs = schedule.exprs.map((expr) => new Cron(expr, cronOptions(timeZone)));
  const pick = (dates: (Date | null | undefined)[], newest: boolean) => {
    const found = dates.filter((date): date is Date => Boolean(date));
    if (!found.length) return null;
    return new Date((newest ? Math.max : Math.min)(...found.map((date) => date.getTime())));
  };
  return {
    next: (after: Date) => pick(jobs.map((job) => job.nextRun(after)), false),
    previous: (before: Date) => pick(jobs.map((job) => job.previousRuns(1, before)[0]), true),
  };
}

/** "Every N minutes" (exprs "* * * * *") is plain arithmetic from the anchor, no minute-by-minute scan. */
const minuteStep = (schedule: CronSchedule) =>
  schedule.repeat?.unit === "minute" ? { anchor: Date.parse(schedule.repeat.anchor), step: schedule.repeat.every * 60_000 } : null;

// Bounds the scan over thinned slots ("every 999 hours" skips 998 of every 999).
const SCAN_LIMIT = 20_000;

/** The next `count` fire times after `from`. Throws on an invalid expression. */
export function nextRuns(schedule: RoutineSchedule, timeZone: string | undefined, count: number, from = new Date()): Date[] {
  if (schedule.kind === "manual") return [];
  if (schedule.kind === "once") {
    const at = onceInstant(schedule.at, timeZone);
    return at && at.getTime() > from.getTime() && count > 0 ? [at] : [];
  }
  const runs: Date[] = [];
  const steps = minuteStep(schedule);
  if (steps) {
    let k = Math.max(0, Math.floor((from.getTime() - steps.anchor) / steps.step) + 1);
    while (runs.length < count) {
      const run = new Date(steps.anchor + k++ * steps.step);
      if (ended(schedule, run, timeZone)) break;
      runs.push(run);
    }
    return runs;
  }
  const { next } = slots(schedule, timeZone);
  let cursor: Date | null = from;
  for (let i = 0; runs.length < count && i < SCAN_LIMIT; i++) {
    cursor = next(cursor);
    if (!cursor || ended(schedule, cursor, timeZone)) break;
    if (keeps(schedule, cursor, timeZone)) runs.push(cursor);
  }
  return runs;
}

/** The newest fire time in (after, atOrBefore], if any. */
export function latestRun(schedule: RoutineSchedule, timeZone: string | undefined, atOrBefore: Date, after: Date): Date | null {
  if (schedule.kind === "manual") return null;
  if (schedule.kind === "once") {
    const at = onceInstant(schedule.at, timeZone);
    return at && at.getTime() > after.getTime() && at.getTime() <= atOrBefore.getTime() ? at : null;
  }
  const steps = minuteStep(schedule);
  if (steps) {
    if (atOrBefore.getTime() < steps.anchor) return null;
    let run = new Date(steps.anchor + Math.floor((atOrBefore.getTime() - steps.anchor) / steps.step) * steps.step);
    // Past the end date: the newest slot is the last one on or before it.
    while (run.getTime() > after.getTime() && ended(schedule, run, timeZone)) run = new Date(run.getTime() - steps.step);
    return run.getTime() > after.getTime() && run.getTime() >= steps.anchor ? run : null;
  }
  const { previous } = slots(schedule, timeZone);
  let cursor = new Date(atOrBefore.getTime() + 1);
  for (let i = 0; i < SCAN_LIMIT; i++) {
    const found = previous(cursor);
    if (!found || found.getTime() <= after.getTime()) return null;
    if (!ended(schedule, found, timeZone) && keeps(schedule, found, timeZone)) return found;
    cursor = found;
  }
  return null;
}

/** Whether two of the next 60 runs are closer than `minGapMs`. Throws on an invalid expression. */
export function firesTooOften(schedule: RoutineSchedule, minGapMs: number, timeZone?: string, from = new Date()): boolean {
  const runs = nextRuns(schedule, timeZone, 60, from);
  return runs.some((run, i) => i > 0 && run.getTime() - runs[i - 1].getTime() < minGapMs);
}

/**
 * The next few fire times for the form, or the parse error for a bad expression. The
 * frequency check runs in the local zone: croner with an explicit zone costs ~0.4 ms a slot
 * (60 slots per edit felt sluggish), gaps only differ across DST, and the server rechecks.
 */
export function previewRuns(schedule: RoutineSchedule, timeZone?: string, count = 3, from = new Date(), minGapMs = minIntervalMs("new_session")): { runs: Date[]; error?: string; tooOften?: boolean } {
  try {
    return { runs: nextRuns(schedule, timeZone, count, from), tooOften: firesTooOften(schedule, minGapMs, undefined, from) };
  } catch (error) {
    return { runs: [], error: error instanceof Error ? error.message : String(error) };
  }
}
