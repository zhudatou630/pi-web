import { existsSync, readFileSync, statSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { sessionPathKey } from "./session-path";
import { dayKey } from "./usage-view";

/** Token usage of one local day × hour × provider × model within one session file. */
export interface UsageRow {
  day: string;
  /** Local hour 0–23; absent on rows kept from the v1 cache of a since-deleted session. */
  hour?: number;
  provider: string;
  model: string;
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Cost pi recorded at write time; only a fallback when no current price is known. */
  recordedCost: number;
}

export interface SessionUsage {
  cwd: string;
  rows: UsageRow[];
}

/** USD per million tokens, the unit pi's model `cost` uses. */
export interface UsagePrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A priced usage bucket as the Usage page receives it; the page slices these itself. */
export interface UsageRecord {
  day: string;
  hour: number | null;
  model: string;
  project: string;
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Messages with neither a current price nor a recorded cost. */
  unpriced: number;
}

export interface UsageResponse {
  records: UsageRecord[];
  /** Present while a scan is still running in the background. */
  scan: { done: number; total: number } | null;
}

/**
 * Sums assistant usage of one session file. A fork or context-inheriting subagent
 * copies its parent's history into the new file; those copies predate the file's
 * own header, so counting only messages at or after the header drops them.
 */
export function summarizeSessionUsage(text: string): SessionUsage {
  const lines = text.split("\n");
  let header: { timestamp?: string; cwd?: string };
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return { cwd: "", rows: [] };
  }
  const cwd = typeof header.cwd === "string" ? header.cwd : "";
  const start = Date.parse(header.timestamp ?? "");
  if (!Number.isFinite(start)) return { cwd, rows: [] };

  const rows = new Map<string, UsageRow>();
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let entry: { timestamp?: string; message?: Record<string, unknown> };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry.message;
    const usage = message?.usage as Partial<UsagePrice> & { cost?: { total?: number } } | undefined;
    if (message?.role !== "assistant" || !usage) continue;
    const ts = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp ?? "");
    if (!Number.isFinite(ts) || ts < start) continue;

    const local = new Date(ts);
    const day = dayKey(local);
    const hour = local.getHours();
    const provider = String(message.provider ?? "");
    const model = String(message.model ?? "");
    const key = `${day}\0${hour}\0${provider}\0${model}`;
    let row = rows.get(key);
    if (!row) {
      row = { day, hour, provider, model, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, recordedCost: 0 };
      rows.set(key, row);
    }
    row.messages += 1;
    row.input += usage.input ?? 0;
    row.output += usage.output ?? 0;
    row.cacheRead += usage.cacheRead ?? 0;
    row.cacheWrite += usage.cacheWrite ?? 0;
    row.recordedCost += usage.cost?.total ?? 0;
  }
  return { cwd, rows: [...rows.values()] };
}

/**
 * Prices every row at today's rates, like tokscale, and merges files into
 * day × hour × model × project buckets. `lookup` gives the current price of a
 * provider/model; without one the recorded cost stands, and a row with neither
 * is unpriced (reported, never counted as free).
 * ponytail: flat rates, ignores long-context price tiers; price per message if tiers matter.
 */
export function buildUsageRecords(
  sessions: readonly SessionUsage[],
  lookup: (provider: string, model: string) => UsagePrice | null,
  projectOf: (cwd: string) => string,
): UsageRecord[] {
  const prices = new Map<string, UsagePrice | null>();
  const records = new Map<string, UsageRecord>();
  for (const session of sessions) {
    const project = projectOf(session.cwd);
    for (const row of session.rows) {
      const priceKey = `${row.provider}\0${row.model}`;
      if (!prices.has(priceKey)) prices.set(priceKey, lookup(row.provider, row.model));
      const price = prices.get(priceKey);
      const hour = row.hour ?? null;
      // Routers put the vendor in the id (`deepseek/deepseek-v4.1-flash`); the same model
      // reached two ways is one row. Pricing above still used the full id.
      const model = row.model.slice(row.model.lastIndexOf("/") + 1);
      const key = `${row.day}\0${hour}\0${model}\0${project}`;
      let record = records.get(key);
      if (!record) {
        record = { day: row.day, hour, model, project, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 };
        records.set(key, record);
      }
      record.messages += row.messages;
      record.input += row.input;
      record.output += row.output;
      record.cacheRead += row.cacheRead;
      record.cacheWrite += row.cacheWrite;
      record.cost += price
        ? (row.input * price.input + row.output * price.output + row.cacheRead * price.cacheRead + row.cacheWrite * price.cacheWrite) / 1e6
        : row.recordedCost;
      if (!price && row.recordedCost === 0) record.unpriced += row.messages;
    }
  }
  return [...records.values()];
}

// ── Persistent per-file cache ──
// Entries outlive their session files, so deleted sessions keep counting once scanned.

const CACHE_VERSION = 2;

/** `cwd` is absent on entries carried over from the v1 cache; those files get rescanned. */
interface CacheEntry { size: number; mtimeMs: number; cwd?: string; rows: UsageRow[] }

interface ScanState {
  done: number;
  total: number;
  /** Settles once `total` is known (the cheap stat pass is over). */
  planned: Promise<void>;
  promise: Promise<void>;
}

declare global {
  var __piUsageCache: Map<string, CacheEntry> | undefined;
  var __piUsageScanState: ScanState | undefined;
}

function cachePath(): string {
  return join(getAgentDir(), "pi-web-usage-cache.json");
}

function readCacheFile(): Map<string, CacheEntry> {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as { version?: number; files?: Record<string, CacheEntry> };
    if (!parsed.files) return new Map();
    if (parsed.version === CACHE_VERSION) return new Map(Object.entries(parsed.files));
    // v1 rows have no hour and no cwd: still shown until their files are rescanned.
    if (parsed.version === 1) {
      return new Map(Object.entries(parsed.files).map(([path, { size, mtimeMs, rows }]) => [path, { size, mtimeMs, rows }]));
    }
  } catch {
    // missing or corrupt: rebuilt from the session files that still exist
  }
  return new Map();
}

function getCache(): Map<string, CacheEntry> {
  return globalThis.__piUsageCache ??= readCacheFile();
}

/** The dev server and the installed service share this file; keep what the other one recorded. */
function persistCache(cache: Map<string, CacheEntry>): void {
  for (const [path, entry] of readCacheFile()) if (!cache.has(path)) cache.set(path, entry);
  writePrivateFileAtomicSync(cachePath(), JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(cache) }));
}

const isFresh = (entry: CacheEntry | undefined, size: number, mtimeMs: number) =>
  entry !== undefined && entry.cwd !== undefined && entry.size === size && entry.mtimeMs === mtimeMs;

/** Every session file, including runs that extensions nest below a session's directory. */
async function listSessionFiles(): Promise<string[]> {
  const root = join(getAgentDir(), "sessions");
  try {
    return (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".jsonl")).map((f) => join(root, f));
  } catch {
    return [];
  }
}

async function scanUsage(state: ScanState, markPlanned: () => void): Promise<void> {
  const cache = getCache();
  const files = await Promise.all((await listSessionFiles()).map(async (path) => {
    try {
      const { size, mtimeMs } = await stat(path);
      return { path, key: sessionPathKey(path), size, mtimeMs };
    } catch {
      return null; // vanished: its last cached rows (if any) stay
    }
  }));
  const stale = files.filter((f) => f !== null && !isFresh(cache.get(f.key), f.size, f.mtimeMs)) as NonNullable<(typeof files)[number]>[];
  state.total = stale.length;
  markPlanned();
  for (const file of stale) {
    try {
      cache.set(file.key, { size: file.size, mtimeMs: file.mtimeMs, ...summarizeSessionUsage(await readFile(file.path, "utf8")) });
    } catch {
      // vanished mid-scan
    }
    state.done += 1;
  }
  if (stale.length > 0) persistCache(cache);
}

/** Starts a scan of changed session files, or joins the one already running. */
export function startUsageScan(): ScanState {
  if (globalThis.__piUsageScanState) return globalThis.__piUsageScanState;
  let markPlanned!: () => void;
  const state: ScanState = { done: 0, total: 0, planned: new Promise((resolve) => { markPlanned = resolve; }), promise: Promise.resolve() };
  state.promise = scanUsage(state, markPlanned).finally(() => {
    markPlanned(); // a failed stat pass must not leave callers waiting
    globalThis.__piUsageScanState = undefined;
  });
  return globalThis.__piUsageScanState = state;
}

/** What the cache holds right now, including files a running scan has not reached yet. */
export function cachedSessionUsage(): SessionUsage[] {
  return [...getCache().values()].map((entry) => ({ cwd: entry.cwd ?? "", rows: entry.rows }));
}

/** Folds session files into the cache right before they are deleted. */
export function recordUsageBeforeDelete(paths: readonly string[]): void {
  const cache = getCache();
  let changed = false;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const key = sessionPathKey(path);
    const { size, mtimeMs } = statSync(path);
    if (isFresh(cache.get(key), size, mtimeMs)) continue;
    cache.set(key, { size, mtimeMs, ...summarizeSessionUsage(readFileSync(path, "utf8")) });
    changed = true;
  }
  if (changed) persistCache(cache);
}
