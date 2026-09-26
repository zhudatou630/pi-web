"use client";

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getJson, peekJson, settingsUrls } from "@/lib/settings-cache";
import type { UsageRecord, UsageResponse } from "@/lib/usage-stats";
import {
  addDays,
  dayKey,
  groupRecords,
  levelScale,
  parseDay,
  periodOf,
  periodsBetween,
  rangeStart,
  streaks,
  sumRecords,
  type UsageGrain,
  type UsageGroup,
  type UsageRange,
} from "@/lib/usage-view";
import { ConfigEmptyState, SettingsGroup, SettingsLoading, SettingsSegmented } from "./SettingsUi";

type Tab = "overview" | "models" | "projects" | "timeline" | "activity";
type T = (key: string, params?: Record<string, string | number>) => string;

const WEEKS = 53;
const POLL_MS = 1000;
/** "All" charts switch from daily to weekly bars past this many days. */
const MAX_DAILY_BARS = 120;

function useFormat(locale: string) {
  return useMemo(() => {
    const money = (digits: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits });
    const currency = money(1);
    // Unit prices sit around $0.01–$2, where one decimal would erase them.
    const unitCurrency = money(2);
    // Fixed decimals everywhere: tokens, percents and money 1; unit prices 2.
    const compact = new Intl.NumberFormat(locale, { notation: "compact", minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const integer = new Intl.NumberFormat(locale);
    const percent = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const fullDate = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" });
    const shortDate = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
    const month = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short" });
    const monthName = new Intl.DateTimeFormat(locale, { month: "short" });
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
    const weekdayLong = new Intl.DateTimeFormat(locale, { weekday: "long" });
    return {
      cost: (v: number) => (v > 0 && v < 0.05 ? `<${currency.format(0.1)}` : currency.format(v)),
      unitCost: (v: number) => unitCurrency.format(v),
      // A compact form without a unit suffix (zh below 万) would print "2162.0": show the integer.
      tokens: (v: number) => { const out = compact.format(v); return /\d$/.test(out) ? integer.format(Math.round(v)) : out; },
      count: (v: number) => integer.format(v),
      percent: (v: number) => percent.format(v),
      /** Shares too small to round up still read as nonzero. */
      share: (v: number) => (v > 0 && v < 0.001 ? `<${percent.format(0.001)}` : percent.format(v)),
      day: (key: string) => fullDate.format(parseDay(key)),
      shortDay: (key: string) => shortDate.format(parseDay(key)),
      month: (key: string) => month.format(parseDay(key)),
      monthName: (d: Date) => monthName.format(d),
      weekday: (d: Date) => weekday.format(d),
      weekdayLong: (d: Date) => weekdayLong.format(d),
    };
  }, [locale]);
}
type Format = ReturnType<typeof useFormat>;

function periodLabel(key: string, grain: UsageGrain, format: Format, t: T): string {
  if (grain === "month") return format.month(key);
  if (grain === "week") return t("usage.weekOf", { date: format.shortDay(key) });
  return format.day(key);
}

const projectName = (path: string, t: T) => path ? path.split(/[\\/]/).filter(Boolean).pop() ?? path : t("usage.unknownProject");

export function UsageStats() {
  const { t, locale } = useI18n();
  const format = useFormat(locale);
  const [data, setData] = useState<UsageResponse | null>(() => {
    const reply = peekJson<UsageResponse>(settingsUrls.usage);
    return reply?.ok ? reply.data : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [range, setRange] = useState<UsageRange>("30d");

  // A long scan runs in the background; poll until it settles.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      getJson<UsageResponse & { error?: string }>(settingsUrls.usage)
        .then((reply) => {
          if (cancelled) return;
          if (!reply.ok || reply.data.error) throw new Error(reply.data.error ?? `HTTP ${reply.status}`);
          setData(reply.data);
          setError(null);
          if (reply.data.scan) timer = setTimeout(load, POLL_MS);
        })
        .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    };
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const records = useMemo(() => data?.records ?? [], [data]);
  const scoped = useMemo(() => {
    const start = rangeStart(range, today);
    return start ? records.filter((r) => r.day >= start) : records;
  }, [records, range, today]);

  if (!data) {
    return (
      <div className="settings-page">
        {error ? <p role="alert" className="settings-row-message is-error">{error}</p> : <SettingsLoading label={t("i18n.loading")} />}
      </div>
    );
  }

  const scanning = data.scan;
  const tabs: { value: Tab; label: string }[] = [
    { value: "overview", label: t("usage.overview") },
    { value: "models", label: t("common.models") },
    { value: "projects", label: t("usage.projects") },
    { value: "timeline", label: t("usage.timeline") },
    { value: "activity", label: t("usage.activity") },
  ];
  const ranges: { value: UsageRange; label: string }[] = [
    { value: "7d", label: t("usage.days", { count: 7 }) },
    { value: "30d", label: t("usage.days", { count: 30 }) },
    { value: "90d", label: t("usage.days", { count: 90 }) },
    { value: "all", label: t("usage.rangeAll") },
  ];

  let content: ReactNode;
  if (records.length === 0) {
    content = scanning ? null : <ConfigEmptyState>{t("usage.empty")}</ConfigEmptyState>;
  } else if (tab === "activity") {
    content = <Activity records={records} today={today} scanning={Boolean(scanning)} format={format} t={t} />;
  } else if (scoped.length === 0) {
    content = <ConfigEmptyState>{t("usage.emptyRange")}</ConfigEmptyState>;
  } else if (tab === "overview") {
    content = <Overview key={range} records={scoped} range={range} today={today} format={format} t={t} />;
  } else if (tab === "models") {
    content = <UsageTable groups={groupRecords(scoped, (r) => r.model)} nameLabel={t("usage.model")} limit={10} format={format} t={t} />;
  } else if (tab === "projects") {
    content = (
      <UsageTable
        groups={groupRecords(scoped, (r) => r.project)}
        nameLabel={t("usage.project")}
        name={(key) => projectName(key, t)}
        limit={10}
        format={format}
        t={t}
      />
    );
  } else {
    content = <Timeline records={scoped} format={format} t={t} />;
  }

  return (
    <div className="settings-page usage-page">
      {error && <p role="alert" className="settings-row-message is-error">{error}</p>}
      {scanning && (
        <p role="status" className="usage-scan">
          <span>{t("usage.scanning", { done: format.count(scanning.done), total: format.count(scanning.total) })}</span>
          <span className="usage-scan-track" aria-hidden="true">
            <span style={{ width: `${scanning.total ? (scanning.done / scanning.total) * 100 : 0}%` }} />
          </span>
        </p>
      )}
      <div className="usage-toolbar">
        <SettingsSegmented label={t("settings.usage")} options={tabs} value={tab} onChange={setTab} />
        {tab !== "activity" && <SettingsSegmented label={t("usage.range")} options={ranges} value={range} onChange={setRange} />}
      </div>
      {content}
    </div>
  );
}

function Facts({ items }: { items: { label: string; value: string; detail?: string | null }[] }) {
  return (
    <dl className="usage-stats">
      {items.map((item) => (
        <div key={item.label} className="usage-stat">
          <dt>{item.label}</dt>
          <dd className="usage-stat-value" title={item.value}>{item.value}</dd>
          {item.detail && <dd className="usage-stat-detail">{item.detail}</dd>}
        </div>
      ))}
    </dl>
  );
}

interface BarPoint { key: string; value: number; title: string }

/** Plain bar chart; each bar selects its period. */
function Bars({ points, selected, onSelect, start, end, peakLabel }: {
  points: readonly BarPoint[];
  selected: string | null;
  onSelect: (key: string) => void;
  start: string;
  end: string;
  peakLabel: string;
}) {
  const max = Math.max(...points.map((p) => p.value), 0);
  return (
    <div className="usage-chart">
      <span className="usage-chart-peak">{peakLabel}</span>
      <div className="usage-bars" style={{ "--usage-bar-count": points.length } as CSSProperties}>
        {points.map((point) => (
          <button
            key={point.key}
            type="button"
            className="usage-bar"
            style={{ "--usage-bar": max > 0 ? `${(point.value / max) * 100}%` : "0%" } as CSSProperties}
            title={point.title}
            aria-label={point.title}
            aria-pressed={selected === point.key}
            data-dimmed={selected && selected !== point.key ? "" : undefined}
            onClick={() => onSelect(point.key)}
          />
        ))}
      </div>
      <div className="usage-chart-axis"><span>{start}</span><span>{end}</span></div>
    </div>
  );
}

function Overview({ records, range, today, format, t }: { records: UsageRecord[]; range: UsageRange; today: Date; format: Format; t: T }) {
  const [selected, setSelected] = useState<string | null>(null);
  const totals = sumRecords(records);
  const activeDays = new Set(records.map((r) => r.day)).size;
  const first = rangeStart(range, today) ?? records.reduce((min, r) => (r.day < min ? r.day : min), records[0].day);
  const last = dayKey(today);
  const grain: UsageGrain = periodsBetween(first, last, "day").length > MAX_DAILY_BARS ? "week" : "day";
  const byPeriod = new Map(groupRecords(records, (r) => periodOf(r.day, grain)).map((g) => [g.key, g]));
  const periods = periodsBetween(first, last, grain);
  const peak = Math.max(...periods.map((p) => byPeriod.get(p)?.cost ?? 0));
  const points = periods.map((key) => {
    const group = byPeriod.get(key);
    return {
      key,
      value: group?.cost ?? 0,
      title: t("usage.cell", { date: periodLabel(key, grain, format, t), cost: format.cost(group?.cost ?? 0), tokens: format.tokens(group?.tokens ?? 0) }),
    };
  });
  const detail = selected ? byPeriod.get(selected)?.records ?? [] : records;

  return (
    <>
      <Facts items={[
        { label: t("usage.totalCost"), value: format.cost(totals.cost) },
        {
          label: t("usage.totalTokens"),
          value: format.tokens(totals.tokens),
          detail: t("usage.cacheShare", { share: format.percent(totals.cacheRead / Math.max(totals.tokens, 1)) }),
        },
        { label: t("usage.messages"), value: format.count(totals.messages) },
        {
          label: t("usage.avgPerDay"),
          value: format.cost(totals.cost / Math.max(activeDays, 1)),
          detail: t("usage.activeDaysDetail", { count: activeDays }),
        },
      ]} />
      <SettingsGroup title={grain === "day" ? t("usage.dailyCost") : t("usage.weeklyCost")}>
        <Bars
          points={points}
          selected={selected}
          onSelect={(key) => setSelected((current) => (current === key ? null : key))}
          start={periodLabel(periods[0], grain, format, t)}
          end={periodLabel(periods[periods.length - 1], grain, format, t)}
          peakLabel={t("usage.peak", { cost: format.cost(peak) })}
        />
      </SettingsGroup>
      <SettingsGroup
        title={selected ? periodLabel(selected, grain, format, t) : t("usage.topModels")}
        action={selected && (
          <button type="button" className="usage-link" onClick={() => setSelected(null)}>{t("usage.clearSelection")}</button>
        )}
      >
        <UsageTable key={selected ?? ""} groups={groupRecords(detail, (r) => r.model)} nameLabel={t("usage.model")} limit={5} format={format} t={t} />
      </SettingsGroup>
    </>
  );
}

type SortKey = "name" | "input" | "output" | "cacheRead" | "cacheWrite" | "cacheRatio" | "tokens" | "cost" | "costPerMillion";
interface Sort { key: SortKey; desc: boolean }

/** tokscale's derived columns: cache reads per fresh input token, and the effective price. */
const cacheRatio = (g: UsageGroup) => (g.input > 0 ? g.cacheRead / g.input : null);
const costPerMillion = (g: UsageGroup) => (g.tokens > 0 ? (g.cost / g.tokens) * 1e6 : null);
const METRICS: Record<Exclude<SortKey, "name">, (g: UsageGroup) => number | null> = {
  input: (g) => g.input,
  output: (g) => g.output,
  cacheRead: (g) => g.cacheRead,
  cacheWrite: (g) => g.cacheWrite,
  cacheRatio,
  tokens: (g) => g.tokens,
  cost: (g) => g.cost,
  costPerMillion,
};

interface Column {
  sort?: SortKey;
  label: ReactNode;
  hint?: string;
  /** Fixed px width, header label included: labels are worded to fit it in every locale.
      The name column is not listed: it takes the rest and always shows in full. */
  width: number;
  /** Hidden on phones. */
  secondary?: boolean;
  strong?: boolean;
  cell: (group: UsageGroup) => string;
}

/**
 * One table for every breakdown (models, projects, periods): the same fixed-width
 * columns, sorted by clicking a header, long tail folded. `detail` makes rows expandable.
 */
function UsageTable({ groups, nameLabel, name = (key) => key || "—", limit = Infinity, defaultSort = { key: "cost", desc: true }, detail, format, t }: {
  groups: readonly UsageGroup[];
  nameLabel: string;
  name?: (key: string) => string;
  limit?: number;
  defaultSort?: Sort;
  detail?: (group: UsageGroup) => ReactNode;
  format: Format;
  t: T;
}) {
  const [sort, setSort] = useState<Sort>(defaultSort);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const totalCost = groups.reduce((sum, g) => sum + g.cost, 0);
  const totalTokens = groups.reduce((sum, g) => sum + g.tokens, 0);
  // Mobile hides the token-share column; its one share column follows the sort, token % only while sorted by tokens.
  const tokenShareOnly = useIsMobile() && sort.key === "tokens";
  const sorted = [...groups].sort((a, b) => {
    const order = sort.key === "name"
      ? a.key.localeCompare(b.key, undefined, { numeric: true })
      : (METRICS[sort.key](a) ?? -1) - (METRICS[sort.key](b) ?? -1);
    return sort.desc ? -order : order;
  });
  const shown = expanded ? sorted : sorted.slice(0, limit);
  const hidden = groups.length - limit;
  const toggleRow = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  const columns: Column[] = [
    { sort: "input", label: t("usage.input"), width: 64, secondary: true, cell: (g) => format.tokens(g.input) },
    { sort: "output", label: t("usage.output"), width: 64, secondary: true, cell: (g) => format.tokens(g.output) },
    { sort: "cacheRead", label: t("usage.cacheRead"), width: 68, secondary: true, cell: (g) => format.tokens(g.cacheRead) },
    { sort: "cacheWrite", label: t("usage.cacheWrite"), width: 68, secondary: true, cell: (g) => format.tokens(g.cacheWrite) },
    {
      sort: "cacheRatio", label: t("usage.cacheRatio"), hint: t("usage.cacheRatioHint"), width: 64, secondary: true,
      cell: (g) => { const ratio = cacheRatio(g); return ratio === null ? "—" : `${ratio.toFixed(1)}×`; },
    },
    { sort: "tokens", label: t("usage.tokensColumn"), width: 68, cell: (g) => format.tokens(g.tokens) },
    { sort: "cost", label: t("usage.cost"), width: 68, strong: true, cell: (g) => format.cost(g.cost) },
    {
      sort: "costPerMillion", label: t("usage.costPerMillion"), hint: t("usage.costPerMillionHint"), width: 56, secondary: true,
      cell: (g) => { const unit = costPerMillion(g); return unit === null ? "—" : format.unitCost(unit); },
    },
    {
      label: t("usage.tokenShare"), width: 64, secondary: true,
      cell: (g) => (totalTokens > 0 ? format.share(g.tokens / totalTokens) : "—"),
    },
    {
      label: tokenShareOnly ? t("usage.tokenShare") : t("usage.costShare"),
      width: 56,
      cell: (g) => tokenShareOnly
        ? (totalTokens > 0 ? format.share(g.tokens / totalTokens) : "—")
        : (totalCost > 0 ? format.share(g.cost / totalCost) : "—"),
    },
  ];
  const span = columns.length + 1;

  // The sorted column carries an accent bar (CSS); the rows show the direction, aria-sort tells screen readers.
  const sortButton = (key: SortKey, label: ReactNode) => (
    <button
      type="button"
      className="usage-sort"
      onClick={() => setSort((current) => ({ key, desc: current.key === key ? !current.desc : key !== "name" }))}
    >
      {label}
    </button>
  );
  const ariaSort = (key?: SortKey) => (key && sort.key === key ? (sort.desc ? "descending" : "ascending") : undefined);

  return (
    <div className="usage-table-scroll">
      <table className="usage-table">
        <thead>
          <tr>
            <th aria-sort={ariaSort("name")}>{sortButton("name", nameLabel)}</th>
            {columns.map((column, index) => (
              <th
                key={index}
                className={column.secondary ? "is-secondary" : undefined}
                style={{ width: column.width }}
                title={column.hint}
                aria-sort={ariaSort(column.sort)}
              >
                {column.sort ? sortButton(column.sort, column.label) : column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((group) => {
            const isOpen = open.has(group.key);
            return (
              <Fragment key={group.key}>
                <tr className={detail ? "usage-period-row" : undefined} onClick={detail ? () => toggleRow(group.key) : undefined}>
                  <td className="usage-table-name" title={group.key}>
                    {detail ? (
                      <button type="button" className="usage-disclosure" aria-expanded={isOpen} onClick={(event) => { event.stopPropagation(); toggleRow(group.key); }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                        <span>{name(group.key)}</span>
                      </button>
                    ) : <span>{name(group.key)}</span>}
                    {group.unpriced > 0 && <span className="usage-badge" title={t("usage.unpricedNote", { count: group.unpriced })}>{t("usage.unpriced")}</span>}
                  </td>
                  {columns.map((column, index) => (
                    <td key={index} className={[column.secondary && "is-secondary", column.strong && "is-strong"].filter(Boolean).join(" ") || undefined}>
                      {column.cell(group)}
                    </td>
                  ))}
                </tr>
                {detail && isOpen && (
                  <tr className="usage-period-detail">
                    <td colSpan={span}>{detail(group)}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {hidden > 0 && (
            <tr className="usage-table-more">
              <td colSpan={span}>
                <button type="button" className="usage-link" onClick={() => setExpanded(!expanded)}>
                  {expanded ? t("usage.showFewer") : t("usage.showMore", { count: hidden })}
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Timeline({ records, format, t }: { records: UsageRecord[]; format: Format; t: T }) {
  const [grain, setGrain] = useState<UsageGrain>("day");
  const grains: { value: UsageGrain; label: string }[] = [
    { value: "day", label: t("usage.grainDay") },
    { value: "week", label: t("usage.grainWeek") },
    { value: "month", label: t("usage.grainMonth") },
  ];
  return (
    <SettingsGroup action={<SettingsSegmented label={t("usage.timeline")} options={grains} value={grain} onChange={setGrain} />}>
      <UsageTable
        key={grain}
        groups={groupRecords(records, (r) => periodOf(r.day, grain))}
        nameLabel={t("usage.period")}
        name={(key) => periodLabel(key, grain, format, t)}
        defaultSort={{ key: "name", desc: true }}
        detail={(period) => (
          <UsageTable groups={groupRecords(period.records, (r) => r.model)} nameLabel={t("usage.model")} limit={8} format={format} t={t} />
        )}
        format={format}
        t={t}
      />
    </SettingsGroup>
  );
}

function Activity({ records, today, scanning, format, t }: { records: UsageRecord[]; today: Date; scanning: boolean; format: Format; t: T }) {
  const [selected, setSelected] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const view = useMemo(() => {
    // Columns are Monday-first weeks; the last column holds today.
    const start = addDays(today, -((today.getDay() + 6) % 7) - (WEEKS - 1) * 7);
    const inWindow = records.filter((r) => r.day >= dayKey(start));
    const days = new Map(groupRecords(inWindow, (r) => r.day).map((g) => [g.key, g]));
    const level = levelScale([...days.values()].map((d) => d.cost));
    const cells = Array.from({ length: WEEKS * 7 }, (_, index) => {
      const date = addDays(start, Math.floor(index / 7) * 7 + (index % 7));
      return { key: dayKey(date), date, future: date > today };
    });
    const months: { column: number; label: string }[] = [];
    for (let column = 1; column < WEEKS; column += 1) {
      const monday = cells[column * 7].date;
      if (monday.getMonth() !== cells[(column - 1) * 7].date.getMonth()) months.push({ column, label: format.monthName(monday) });
    }
    const allDays = groupRecords(records, (r) => r.day);
    const peak = allDays.reduce<UsageGroup | null>((best, d) => (!best || d.cost > best.cost ? d : best), null);
    return {
      cells,
      months,
      days,
      level,
      yearCost: inWindow.reduce((sum, r) => sum + r.cost, 0),
      streak: streaks(new Set(allDays.map((d) => d.key)), today),
      activeDays: allDays.length,
      peak,
      topModel: groupRecords(records, (r) => r.model)[0],
      weekdays: [0, 2, 4].map((row) => ({ row, label: format.weekday(addDays(start, row)) })),
    };
  }, [records, today, format]);

  // On narrow screens the heatmap scrolls; start at the latest weeks.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [view]);

  const selectedDay = selected ? view.days.get(selected) : undefined;

  return (
    <>
      <Facts items={[
        { label: t("usage.activeDays"), value: t("usage.days", { count: view.activeDays }) },
        { label: t("usage.streak"), value: t("usage.days", { count: view.streak.current }), detail: t("usage.longest", { count: view.streak.longest }) },
        { label: t("usage.peakDay"), value: view.peak ? format.cost(view.peak.cost) : "—", detail: view.peak && format.day(view.peak.key) },
        { label: t("usage.topModel"), value: view.topModel?.key ?? "—", detail: view.topModel && format.cost(view.topModel.cost) },
      ]} />

      <SettingsGroup
        title={t("usage.dailyCost")}
        action={(
          <span className="usage-legend" aria-hidden="true">
            {t("usage.less")}
            {[0, 1, 2, 3, 4].map((level) => <span key={level} className="usage-cell" data-level={level} />)}
            {t("usage.more")}
          </span>
        )}
      >
        <div ref={scrollRef} className="usage-heatmap-scroll">
          <div className="usage-heatmap" style={{ "--usage-weeks": WEEKS } as CSSProperties}>
            {view.months.map((month) => (
              <span key={month.column} className="usage-month" style={{ gridColumn: month.column + 2 }}>{month.label}</span>
            ))}
            {view.weekdays.map((weekday) => (
              <span key={weekday.row} className="usage-weekday" style={{ gridRow: weekday.row + 2 }}>{weekday.label}</span>
            ))}
            {view.cells.map((cell, index) => {
              const day = view.days.get(cell.key);
              const style = { gridColumn: Math.floor(index / 7) + 2, gridRow: (index % 7) + 2 };
              if (cell.future) return <span key={cell.key} className="usage-cell" data-future="" style={style} />;
              const title = t("usage.cell", { date: format.day(cell.key), cost: format.cost(day?.cost ?? 0), tokens: format.tokens(day?.tokens ?? 0) });
              return (
                <button
                  key={cell.key}
                  type="button"
                  className="usage-cell"
                  data-level={view.level(day?.cost ?? 0)}
                  aria-pressed={selected === cell.key}
                  disabled={!day}
                  style={style}
                  title={title}
                  aria-label={title}
                  onClick={() => setSelected((current) => (current === cell.key ? null : cell.key))}
                />
              );
            })}
          </div>
        </div>
        <p className="usage-caption">{t("usage.yearSummary", { cost: format.cost(view.yearCost), days: view.days.size })}</p>
      </SettingsGroup>

      {selectedDay && (
        <SettingsGroup
          title={format.day(selectedDay.key)}
          action={<button type="button" className="usage-link" onClick={() => setSelected(null)}>{t("usage.clearSelection")}</button>}
        >
          <UsageTable key={selectedDay.key} groups={groupRecords(selectedDay.records, (r) => r.model)} nameLabel={t("usage.model")} limit={8} format={format} t={t} />
        </SettingsGroup>
      )}

      <HourlyProfile records={records} scanning={scanning} format={format} t={t} />
    </>
  );
}

/** Day parts, tokscale's split of the clock. */
const DAY_PARTS = [
  { key: "morning", from: 5, to: 11 },
  { key: "daytime", from: 12, to: 16 },
  { key: "evening", from: 17, to: 21 },
  { key: "night", from: 22, to: 4 },
] as const;
const dayPartOf = (hour: number) => DAY_PARTS.findIndex((p) => (p.from <= p.to ? hour >= p.from && hour <= p.to : hour >= p.from || hour <= p.to));
const clock = (hour: number, minute: string) => `${String(hour).padStart(2, "0")}:${minute}`;

/** Share rows: a label, an optional time span, a bar scaled to the largest row, the share. */
function ShareRows({ rows, percent }: { rows: { key: string; label: string; span?: string; value: number }[]; percent: (v: number) => string }) {
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const max = Math.max(...rows.map((r) => r.value), 0);
  return (
    <div className="usage-share-rows">
      {rows.map((row) => (
        <div key={row.key} className="usage-share-row" data-top={row.value === max && max > 0 ? "" : undefined}>
          <span className="usage-share-label">{row.label}</span>
          {row.span !== undefined && <span className="usage-share-span">{row.span}</span>}
          <span className="usage-share-track" aria-hidden="true">
            <span style={{ width: `${max > 0 ? (row.value / max) * 100 : 0}%` }} />
          </span>
          <span className="usage-share-value">{total > 0 ? percent(row.value / total) : "—"}</span>
        </div>
      ))}
    </div>
  );
}

/** When the work happens, by tokens like tokscale's Hourly Profile: day parts, weekdays, the peak hour. */
function HourlyProfile({ records, scanning, format, t }: { records: UsageRecord[]; scanning: boolean; format: Format; t: T }) {
  const timed = records.filter((r) => r.hour !== null);
  if (timed.length === 0) return null;
  const tokensOf = (r: UsageRecord) => r.input + r.output + r.cacheRead + r.cacheWrite;
  const parts = [0, 0, 0, 0];
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  const byHour = groupRecords(timed, (r) => String(r.hour));
  for (const r of timed) {
    parts[dayPartOf(r.hour!)] += tokensOf(r);
    weekdays[(parseDay(r.day).getDay() + 6) % 7] += tokensOf(r);
  }
  const peak = byHour.reduce((best, g) => (g.tokens > best.tokens ? g : best));
  const peakHour = Number(peak.key);
  const totals = sumRecords(timed);
  const hours = new Set(timed.map((r) => `${r.day} ${r.hour}`)).size;
  const days = timed.map((r) => r.day).sort();
  const monday = new Date(2024, 0, 1);

  return (
    <SettingsGroup title={t("usage.hourProfile")}>
      <p className="usage-caption usage-profile-summary">
        {t("usage.profileSummary", {
          from: format.day(days[0]),
          to: format.day(days[days.length - 1]),
          hours: format.count(hours),
          tokens: format.tokens(totals.tokens),
          cost: format.cost(totals.cost),
        })}
      </p>
      {scanning && <p className="usage-caption">{t("usage.hourCalculating")}</p>}
      {/* Side by side on desktop, so the bars keep TUI-like proportions instead of stretching. */}
      <div className="usage-profile">
        <section>
          <h4 className="usage-subtitle">{t("usage.whenYouWork")}</h4>
          <ShareRows percent={format.percent} rows={DAY_PARTS.map((part, index) => ({
            key: part.key,
            label: t(`usage.part.${part.key}`),
            span: `${clock(part.from, "00")}–${clock(part.to, "59")}`,
            value: parts[index],
          }))} />
        </section>
        <section>
          <h4 className="usage-subtitle">{t("usage.byWeekday")}</h4>
          <ShareRows percent={format.percent} rows={weekdays.map((value, index) => ({
            key: String(index),
            label: format.weekdayLong(addDays(monday, index)),
            value,
          }))} />
        </section>
      </div>
      <p className="usage-caption">
        {t("usage.peakHour", { span: `${clock(peakHour, "00")}–${clock(peakHour, "59")}`, tokens: format.tokens(peak.tokens), cost: format.cost(peak.cost) })}
      </p>
    </SettingsGroup>
  );
}
