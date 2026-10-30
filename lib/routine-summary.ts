import { draftFromSchedule, LAST_DAY, sortedTimes, type RoutineSchedule } from "./routine-schedule";

// Human wording of a routine schedule: the Routines list and the chat tool's confirmation
// card say the same thing (docs/routines.md). Pure, so the server can use it with English.

export type Translate = (key: string, params?: Record<string, string | number>) => string;

// Monday first; 2026-01-04 is a Sunday, so day d is 2026-01-(4 + d).
export const WEEK = [1, 2, 3, 4, 5, 6, 0];
const pad = (value: number) => String(value).padStart(2, "0");
/** The locale's list separator: "、" in Chinese, ", " otherwise. */
export const listJoin = (locale: string) => (locale.startsWith("zh") ? "、" : ", ");

export function weekdayName(day: number, locale: string, width: "short" | "long" = "short"): string {
  return new Intl.DateTimeFormat(locale, { weekday: width }).format(new Date(2026, 0, 4 + day));
}

/** "Mon, Fri" / "周一、周五", Monday first. */
export function weekdayList(days: readonly number[], locale: string): string {
  return WEEK.filter((day) => days.includes(day)).map((day) => weekdayName(day, locale)).join(listJoin(locale));
}

/** "Day 1, Day 15, Last day" / "1 日、15 日、最后一天". */
export function monthDayList(days: readonly number[], locale: string, t: Translate): string {
  return [...days].sort((a, b) => a - b)
    .map((day) => (day === LAST_DAY ? t("routines.schedule.lastDay") : t("routines.schedule.dayN", { day })))
    .join(listJoin(locale));
}

/** YYYY-MM-DD that is a real date. */
export function isDateKey(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The locale's AM/PM words ("上午"/"下午", "AM"/"PM") and whether they come before the time. */
export function dayPeriods(locale: string): { am: string; pm: string; first: boolean } {
  const parts = (hour: number) => new Intl.DateTimeFormat(locale, { hour: "numeric", hour12: true }).formatToParts(new Date(2026, 0, 1, hour));
  const period = (hour: number) => parts(hour).find((part) => part.type === "dayPeriod")?.value ?? (hour < 12 ? "AM" : "PM");
  const order = parts(9).map((part) => part.type);
  return { am: period(9), pm: period(15), first: order.indexOf("dayPeriod") < order.indexOf("hour") };
}

/** "上午 09:00" / "09:00 AM": the 12-hour clock the time picker shows, in the locale's word order. */
export function formatClock(hour: number, minute: number, locale: string): string {
  const { am, pm, first } = dayPeriods(locale);
  const period = hour < 12 ? am : pm;
  const clock = `${pad(hour % 12 || 12)}:${pad(minute)}`;
  return first ? `${period} ${clock}` : `${clock} ${period}`;
}

/** One line: "Every weekday at 09:00 AM", "Every 30 minutes", "Once on Nov 3, 2026 at 03:00 PM". */
export function describeSchedule(schedule: RoutineSchedule, locale: string, t: Translate): string {
  const draft = draftFromSchedule(schedule);
  const params = {
    time: sortedTimes(draft.times).map((time) => formatClock(time.hour, time.minute, locale)).join(listJoin(locale)),
    minute: pad(draft.minute),
    monthDays: monthDayList(draft.monthDays, locale, t),
    count: draft.every,
    days: weekdayList(draft.weekdays, locale),
  };
  const until = (text: string) => (draft.endsAt ? t("routines.summary.until", { text, date: draft.endsAt }) : text);
  switch (draft.preset) {
    case "manual": return t("routines.summary.manual");
    case "once": return t("routines.summary.once", {
      time: params.time,
      // A calendar date, not an instant: format it as UTC so no zone shifts the day.
      date: isDateKey(draft.onceDate)
        ? new Date(`${draft.onceDate}T00:00:00Z`).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
        : draft.onceDate,
    });
    case "cron": return until(t("routines.summary.cron", { cron: draft.cron.split("\n").join("; ") }));
    case "weekdays": return t("routines.summary.weekdays", params);
    case "custom": return until(t(`routines.summary.${draft.unit}${draft.every > 1 ? "s" : ""}`, params));
    default: return t(`routines.summary.${{ hourly: "hour", daily: "day", weekly: "week", monthly: "month" }[draft.preset]}`, params);
  }
}
