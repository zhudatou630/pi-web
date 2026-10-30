"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { draftFromSchedule, LAST_DAY, normalizeExpr, REPEAT_UNITS, SCHEDULE_PRESETS, scheduleFromDraft, type RepeatUnit, type ScheduleDraft } from "@/lib/routine-schedule";
import { Select } from "./Select";
import { SettingsSegmented } from "./SettingsUi";
import { TimePicker } from "./TimePicker";
import { isDateKey, monthDayList, WEEK, weekdayList, weekdayName } from "@/lib/routine-summary";

const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const MONTH_DAYS = [...Array.from({ length: 31 }, (_, i) => i + 1), LAST_DAY];
const MAX_TIMES = 8;
const pad = (value: number) => String(value).padStart(2, "0");

/** What the form cannot save as is; null when the draft is complete. */
export function scheduleDraftProblem(draft: ScheduleDraft): "noDays" | "noMonthDays" | "noCron" | "badEnd" | "badDate" | null {
  if (draft.preset === "once" && !isDateKey(draft.onceDate)) return "badDate";
  const unit = draft.preset === "custom" ? draft.unit : draft.preset === "weekly" ? "week" : draft.preset === "monthly" ? "month" : null;
  if (unit === "week" && draft.weekdays.length === 0) return "noDays";
  if (unit === "month" && draft.monthDays.length === 0) return "noMonthDays";
  if (draft.preset === "cron" && !draft.cron.trim()) return "noCron";
  if ((draft.preset === "custom" || draft.preset === "cron") && draft.endsAt !== null && !isDateKey(draft.endsAt)) return "badEnd";
  return null;
}

/** The browser's calendar date `days` from today, YYYY-MM-DD (a form default the user then edits). */
function localDateKey(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const cronLines = (text: string) => text.split("\n").map(normalizeExpr).filter(Boolean);

/** The form fields the cron text maps to, when the form can show it. */
function formFieldsFromCron(text: string): Partial<ScheduleDraft> {
  const lines = cronLines(text);
  if (!lines.length) return {};
  const parsed = draftFromSchedule({ kind: "cron", exprs: lines });
  if (parsed.preset === "cron") return {};
  const { times, minute, weekdays, monthDays, unit, every } = parsed;
  return { times, minute, weekdays, monthDays, unit, every };
}

function CloseGlyph() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>;
}

function PlusGlyph() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

/**
 * Frequency as a segmented row, then the fields it needs as labelled controls:
 * "At [9:00 AM] [6:00 PM] +  On [Mon, Fri]". Custom adds "Every [N] [units]" and an end
 * date; Cron edits the expressions the form compiles to (one per line).
 */
export function RoutineSchedulePicker({ draft, onChange }: {
  draft: ScheduleDraft;
  onChange: (patch: Partial<ScheduleDraft>) => void;
}) {
  const { t, locale } = useI18n();
  const control = "select-trigger routines-schedule-control";
  const unit: RepeatUnit | null = draft.preset === "custom" ? draft.unit
    : draft.preset === "hourly" ? "hour"
      : draft.preset === "daily" || draft.preset === "weekdays" ? "day"
        : draft.preset === "weekly" ? "week"
          : draft.preset === "monthly" ? "month" : null;
  const item = (key: string, label: string, children: ReactNode) => (
    <span key={key} className="routines-schedule-item">
      <span className="routines-schedule-label">{label}</span>
      {children}
    </span>
  );

  const choosePreset = (preset: ScheduleDraft["preset"]) => {
    if (preset === draft.preset) return;
    if (preset === "cron") {
      // Start from what the form already says, so Cron shows its translation.
      const compiled = draft.preset === "manual" ? null : scheduleFromDraft(draft);
      onChange({ preset, cron: compiled?.kind === "cron" ? compiled.exprs.join("\n") : draft.cron, cronRepeat: null });
      return;
    }
    const fields = draft.preset === "cron" ? formFieldsFromCron(draft.cron) : {};
    const next = { ...draft, ...fields };
    onChange({
      ...fields,
      preset,
      // A one-time run starts as tomorrow at the first time already set.
      ...(preset === "once" && !draft.onceDate ? { onceDate: localDateKey(1) } : {}),
      // Weekly starts from the weekdays a "weekdays" schedule already had, or Monday.
      ...(preset === "weekly" && next.weekdays.length === 0 ? { weekdays: [1] } : {}),
      ...(preset === "monthly" && next.monthDays.length === 0 ? { monthDays: [1] } : {}),
      ...(preset === "custom" && unit && !fields.unit ? { unit } : {}),
    });
  };

  const addTime = () => {
    const last = draft.times[draft.times.length - 1] ?? { hour: 8, minute: 0 };
    const taken = new Set(draft.times.map((time) => time.hour * 60 + time.minute));
    let hour = last.hour;
    do hour = (hour + 1) % 24; while (taken.has(hour * 60 + last.minute) && hour !== last.hour);
    onChange({ times: [...draft.times, { hour, minute: last.minute }] });
  };
  const time = item("time", t("routines.schedule.at"), (
    <span className="routines-schedule-times">
      {draft.times.map((entry, index) => (
        <span key={index} className="routines-schedule-time">
          <TimePicker
            className={control}
            ariaLabel={t("routines.time")}
            locale={locale}
            hour={entry.hour}
            minute={entry.minute}
            onChange={(hour, minute) => onChange({ times: draft.times.map((other, i) => (i === index ? { hour, minute } : other)) })}
          />
          {draft.times.length > 1 && (
            <button
              type="button"
              className="ghost-icon-button"
              aria-label={t("routines.schedule.removeTime")}
              title={t("routines.schedule.removeTime")}
              onClick={() => onChange({ times: draft.times.filter((_, i) => i !== index) })}
            >
              <CloseGlyph />
            </button>
          )}
        </span>
      ))}
      {draft.times.length < MAX_TIMES && (
        <button type="button" className="ghost-icon-button" aria-label={t("routines.schedule.addTime")} title={t("routines.schedule.addTime")} onClick={addTime}>
          <PlusGlyph />
        </button>
      )}
    </span>
  ));
  const minute = item("minute", t("routines.schedule.atMinute"), (
    <Select
      className={control}
      ariaLabel={t("routines.schedule.atMinute")}
      value={String(draft.minute)}
      onChange={(value) => onChange({ minute: Number(value) })}
      options={MINUTES.map((value) => ({ value: String(value), label: `:${pad(value)}` }))}
    />
  ));
  const days = item("days", t("routines.schedule.on"), (
    <Select
      className={control}
      ariaLabel={t("routines.weekday")}
      value=""
      label={draft.weekdays.length ? weekdayList(draft.weekdays, locale) : t("routines.schedule.pickDays")}
      isSelected={(value) => draft.weekdays.includes(Number(value))}
      onChange={(value) => {
        const day = Number(value);
        onChange({ weekdays: draft.weekdays.includes(day) ? draft.weekdays.filter((entry) => entry !== day) : [...draft.weekdays, day] });
      }}
      options={WEEK.map((day) => ({ value: String(day), label: weekdayName(day, locale, "long") }))}
    />
  ));
  const monthDays = item("monthDays", t("routines.schedule.onDay"), (
    <Select
      className={control}
      ariaLabel={t("routines.schedule.monthDay")}
      value=""
      label={draft.monthDays.length ? monthDayList(draft.monthDays, locale, t) : t("routines.schedule.pickDays")}
      isSelected={(value) => draft.monthDays.includes(Number(value))}
      onChange={(value) => {
        const day = Number(value);
        onChange({ monthDays: draft.monthDays.includes(day) ? draft.monthDays.filter((entry) => entry !== day) : [...draft.monthDays, day] });
      }}
      options={MONTH_DAYS.map((day) => ({ value: String(day), label: day === LAST_DAY ? t("routines.schedule.lastDay") : t("routines.schedule.dayN", { day }) }))}
    />
  ));
  const once = draft.preset === "once" && [
    item("onceDate", t("routines.schedule.onDay"), (
      <input
        className="routines-schedule-input is-date"
        aria-label={t("routines.schedule.date")}
        placeholder="YYYY-MM-DD"
        value={draft.onceDate}
        onChange={(event) => onChange({ onceDate: event.target.value.slice(0, 10) })}
      />
    )),
    item("onceTime", t("routines.schedule.at"), (
      <TimePicker
        className={control}
        ariaLabel={t("routines.time")}
        locale={locale}
        hour={draft.times[0]?.hour ?? 9}
        minute={draft.times[0]?.minute ?? 0}
        onChange={(hour, minute) => onChange({ times: [{ hour, minute }, ...draft.times.slice(1)] })}
      />
    )),
  ];
  const details = once ? once : unit === "hour" ? [minute] : unit === "day" ? [time]
    : unit === "week" ? [time, days]
      : unit === "month" ? [time, monthDays] : [];

  const repeat = draft.preset === "custom" && item("every", t("routines.schedule.every"), (
    <>
      <input
        className="routines-schedule-input"
        aria-label={t("routines.schedule.everyCount")}
        inputMode="numeric"
        value={String(draft.every)}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "").slice(0, 3);
          onChange({ every: digits ? Number(digits) : 0 });
        }}
        onBlur={() => { if (draft.every < 1) onChange({ every: 1 }); }}
      />
      <Select
        className={control}
        ariaLabel={t("routines.schedule.unit")}
        value={draft.unit}
        // The trigger reads with the count ("1 hour", "2 hours"); the menu lists units in one form.
        label={t(`routines.unit.${draft.unit}${draft.every === 1 ? "" : "s"}`)}
        onChange={(value) => {
          const next = value as RepeatUnit;
          onChange({
            unit: next,
            // A rhythm counts in its own unit; the old anchor would set the wrong phase.
            anchor: null,
            // Under 15 minutes cannot be saved; start from a valid count. Other counts are kept.
            ...(next === "minute" && draft.every < 15 ? { every: 30 } : {}),
            ...(next === "week" && draft.weekdays.length === 0 ? { weekdays: [1] } : {}),
            ...(next === "month" && draft.monthDays.length === 0 ? { monthDays: [1] } : {}),
          });
        }}
        options={REPEAT_UNITS.map((entry) => ({ value: entry, label: t(`routines.unit.${entry}s`) }))}
      />
    </>
  ));
  const ends = (draft.preset === "custom" || draft.preset === "cron") && item("ends", t("routines.schedule.ends"), (
    <>
      <Select
        className={control}
        ariaLabel={t("routines.schedule.ends")}
        value={draft.endsAt === null ? "never" : "on"}
        onChange={(value) => onChange({ endsAt: value === "never" ? null : localDateKey(30) })}
        options={[
          { value: "never", label: t("routines.schedule.endsNever") },
          { value: "on", label: t("routines.schedule.endsOn") },
        ]}
      />
      {draft.endsAt !== null && (
        <input
          className="routines-schedule-input is-date"
          aria-label={t("routines.schedule.endDate")}
          placeholder="YYYY-MM-DD"
          value={draft.endsAt}
          onChange={(event) => onChange({ endsAt: event.target.value.slice(0, 10) })}
        />
      )}
    </>
  ));

  return (
    <div className="routines-schedule">
      <SettingsSegmented
        label={t("routines.frequency")}
        value={draft.preset}
        onChange={choosePreset}
        options={SCHEDULE_PRESETS.map((preset) => ({ value: preset, label: t(`routines.schedule.${preset}`) }))}
      />
      {draft.preset === "cron" ? (
        <>
          {/* Like Claude's: a labelled full-width field, one line per expression (it grows with Enter). */}
          <label className="routines-schedule-field">
            <span className="config-field-label">{t("routines.cron")}</span>
            <textarea
              className="routines-schedule-cron"
              spellCheck={false}
              rows={Math.max(1, draft.cron.split("\n").length)}
              placeholder="0 9 * * *"
              value={draft.cron}
              onChange={(event) => onChange({ cron: event.target.value })}
            />
            <span className="routines-schedule-hint">{t("routines.schedule.cronHint")}</span>
          </label>
          <div className="routines-schedule-row">{ends}</div>
        </>
      ) : (repeat || details.length > 0) && (
        <div className="routines-schedule-row">
          {repeat}
          {details}
          {ends}
        </div>
      )}
    </div>
  );
}
