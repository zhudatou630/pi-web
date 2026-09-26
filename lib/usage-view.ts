import type { UsageRecord } from "./usage-stats";

export type UsageRange = "7d" | "30d" | "90d" | "all";
export type UsageGrain = "day" | "week" | "month";

export interface UsageTotals {
  cost: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  unpriced: number;
}

export interface UsageGroup extends UsageTotals {
  key: string;
  records: UsageRecord[];
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDay = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d ?? 1);
};
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function emptyTotals(): UsageTotals {
  return { cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, unpriced: 0 };
}

function add(totals: UsageTotals, r: UsageRecord): void {
  totals.cost += r.cost;
  totals.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
  totals.input += r.input;
  totals.output += r.output;
  totals.cacheRead += r.cacheRead;
  totals.cacheWrite += r.cacheWrite;
  totals.messages += r.messages;
  totals.unpriced += r.unpriced;
}

export function sumRecords(records: readonly UsageRecord[]): UsageTotals {
  const totals = emptyTotals();
  for (const r of records) add(totals, r);
  return totals;
}

/** Groups records by `keyOf`, most expensive first (ties by tokens). */
export function groupRecords(records: readonly UsageRecord[], keyOf: (r: UsageRecord) => string): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const r of records) {
    const key = keyOf(r);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { key, records: [], ...emptyTotals() });
    group.records.push(r);
    add(group, r);
  }
  return [...groups.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}

/** First day of the range, or null for all time. Ranges end today and include it. */
export function rangeStart(range: UsageRange, today: Date): string | null {
  if (range === "all") return null;
  return dayKey(addDays(today, 1 - Number.parseInt(range, 10)));
}

/** The period `day` falls in: itself, its Monday-first week's Monday, or its month. */
export function periodOf(day: string, grain: UsageGrain): string {
  if (grain === "day") return day;
  if (grain === "month") return day.slice(0, 7);
  const d = parseDay(day);
  return dayKey(addDays(d, -((d.getDay() + 6) % 7)));
}

/** Every period from `first` through `last`, so empty days still take a slot in a chart. */
export function periodsBetween(first: string, last: string, grain: UsageGrain): string[] {
  const out: string[] = [];
  let d = parseDay(periodOf(first, grain));
  const end = periodOf(last, grain);
  for (;;) {
    const key = grain === "month" ? dayKey(d).slice(0, 7) : dayKey(d);
    if (key > end) return out;
    out.push(key);
    d = grain === "day" ? addDays(d, 1) : grain === "week" ? addDays(d, 7) : new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
}

export function streaks(activeDays: ReadonlySet<string>, today: Date): { current: number; longest: number } {
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const key of [...activeDays].sort()) {
    run = previous && dayKey(addDays(parseDay(previous), 1)) === key ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = key;
  }
  // Today still counts as unbroken before its first message.
  let cursor = activeDays.has(dayKey(today)) ? today : addDays(today, -1);
  let current = 0;
  while (activeDays.has(dayKey(cursor))) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return { current, longest };
}

/** Heatmap level 0–4 by quartiles of the nonzero values, so one huge day does not wash the rest out. */
export function levelScale(values: readonly number[]): (value: number) => number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  const thresholds = [0.25, 0.5, 0.75].map((q) => sorted[Math.floor(q * (sorted.length - 1))] ?? 0);
  return (value) => (value <= 0 ? 0 : 1 + thresholds.filter((t) => value > t).length);
}
