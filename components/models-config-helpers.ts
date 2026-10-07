import { isRecord } from "../lib/model-config-validation";
export { findInvalidSamplingParams } from "../lib/model-config-validation";

export interface CompatEntry {
  compat?: Record<string, unknown>;
}

export interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

export const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

export type ModelCostKey = (typeof MODEL_COST_KEYS)[number];

export type ModelCostRates = Record<ModelCostKey, number>;

export type ModelCostDraft = Record<ModelCostKey, string>;

export function modelCostToDraft(cost?: Partial<ModelCostRates>): ModelCostDraft {
  return {
    input: cost?.input === undefined ? "" : String(cost.input),
    output: cost?.output === undefined ? "" : String(cost.output),
    cacheRead: cost?.cacheRead === undefined ? "" : String(cost.cacheRead),
    cacheWrite: cost?.cacheWrite === undefined ? "" : String(cost.cacheWrite),
  };
}

export function parseCompleteModelCost(draft: ModelCostDraft): ModelCostRates | undefined {
  if (!hasModelCostDraftValue(draft)) return undefined;

  const parse = (value: string): number | undefined => {
    if (!value.trim()) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const input = parse(draft.input);
  const output = parse(draft.output);
  const cacheRead = parse(draft.cacheRead);
  const cacheWrite = parse(draft.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

export function hasModelCostDraftValue(draft: ModelCostDraft): boolean {
  return MODEL_COST_KEYS.some((key) => draft[key].trim() !== "");
}

export function setCompatBool<T extends CompatEntry>(entry: T, key: string, value: boolean): T {
  return {
    ...entry,
    compat: { ...(entry.compat ?? {}), [key]: value },
  };
}

export function updateHeaderRow(
  rows: readonly HeaderRow[],
  id: number,
  changes: Partial<Pick<HeaderRow, "name" | "value">>,
): HeaderRow[] {
  return rows.map((row) => row.id === id ? { ...row, ...changes } : row);
}

export function serializeHeaderRows(rows: readonly HeaderRow[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) headers[name] = row.value;
  }
  return Object.keys(headers).length ? headers : undefined;
}

const MODEL_OVERRIDE_KEYS = [
  // Keys the SDK's applyModelOverride actually merges into a catalog model.
  // `api` and `baseUrl` are definition-only: an override carrying them would be
  // written to models.json and then silently ignored at runtime.
  "name", "reasoning", "thinkingLevelMap", "input",
  "contextWindow", "maxTokens", "cost", "headers", "compat", "samplingParams",
] as const;

/** APIs whose SDK request builders apply `samplingParams` today. */
export const SAMPLING_PARAMS_APIS = ["openai-completions", "openai-responses", "azure-openai-responses"] as const;

/**
 * Editor text for `samplingParams`: blank deletes the key, a JSON object is
 * stored as is, anything else stays the raw text. A string in the draft marks
 * it invalid; save refuses it (client and `writeModelsConfig`), so it is never
 * silently dropped, and the dirty draft keeps the text across navigation.
 */
export function parseSamplingParamsDraft(text: string): Record<string, unknown> | string | undefined {
  if (!text.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
  } catch {}
  return text;
}

export function formatSamplingParams(value: Record<string, unknown> | string | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export type ModelOverrideFields = {
  id?: string;
  name?: string;
  /** Catalog value shown in the editor; not a `modelOverrides` key. */
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Partial<ModelCostRates>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  /** A string is an unparsed editor draft; see `parseSamplingParamsDraft`. */
  samplingParams?: Record<string, unknown> | string;
};

function overrideValueEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function mergeRuntimeModel<T extends ModelOverrideFields>(
  runtime: T,
  override?: ModelOverrideFields,
): T {
  if (!override) return { ...runtime, id: runtime.id };
  return {
    ...runtime,
    ...override,
    id: runtime.id,
    cost: override.cost ? { ...runtime.cost, ...override.cost } : runtime.cost,
  };
}

/**
 * The catalog entry already merged the *saved* override's `samplingParams`
 * (SDK: `{ ...base, ...override }`). Strip those keys so a cleared draft shows
 * what remains without the override instead of the old saved object.
 * ponytail: a base key the saved override also sets is hidden too; no shipped
 * model has samplingParams today, expose the pre-override model if one does.
 */
export function withoutSavedSamplingParams<T extends ModelOverrideFields>(runtime: T, saved?: ModelOverrideFields): T {
  const savedParams = saved?.samplingParams;
  if (!runtime.samplingParams || typeof runtime.samplingParams === "string" || !savedParams || typeof savedParams === "string") return runtime;
  const rest = { ...runtime.samplingParams };
  for (const key of Object.keys(savedParams)) delete rest[key];
  return { ...runtime, samplingParams: Object.keys(rest).length ? rest : undefined };
}

export function assignRuntimeOverride(
  overrides: Record<string, unknown> | undefined,
  runtimeId: string,
  override: ModelOverrideFields | undefined,
): Record<string, unknown> | undefined {
  const next = { ...(overrides ?? {}) };
  delete next[runtimeId];
  if (override) next[runtimeId] = override;
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * `runtime` comes from the composed catalog, which already contains the saved
 * override. A key from `previous` that this edit left untouched is kept even
 * when it equals `runtime`; otherwise the next unrelated edit after a save
 * would drop every saved override field. Keys this editor does not manage
 * (`samplingParamsByThinkingLevel`, hand-written extras) are carried over.
 */
export function diffModelOverride(
  runtime: ModelOverrideFields,
  edited: ModelOverrideFields,
  previous?: ModelOverrideFields,
): ModelOverrideFields | undefined {
  const next: ModelOverrideFields = { ...previous };
  delete next.id;
  for (const key of MODEL_OVERRIDE_KEYS) {
    const value = edited[key];
    const kept = previous?.[key] !== undefined && overrideValueEqual(value, previous[key]);
    if (value !== undefined && (kept || !overrideValueEqual(value, runtime[key]))) {
      (next as Record<string, unknown>)[key] = value;
    } else {
      delete next[key];
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
