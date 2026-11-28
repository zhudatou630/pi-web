import { isRecord } from "../lib/model-config-validation";
import type { ModelCatalogPreset, ModelCatalogRecommendation } from "../lib/model-catalog";
import type { ModelsJson } from "./models/types";
export { findInvalidSamplingParams } from "../lib/model-config-validation";

const MODEL_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortModelEntries<T extends { id: string; name?: string }>(models: readonly T[]): T[] {
  return [...models].sort((a, b) => MODEL_NAME_COLLATOR.compare(a.name?.trim() || a.id, b.name?.trim() || b.id));
}

export function moveModelEntry<T>(models: readonly T[], from: number, to: number): T[] | null {
  if (from === to || from < 0 || to < 0 || from >= models.length || to >= models.length) return null;
  const next = [...models];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Convert an insertion slot to the final index after removing the dragged row. */
export function modelDropIndex(from: number, target: number, after: boolean): number {
  const slot = target + Number(after);
  return slot > from ? slot - 1 : slot;
}

export function selectModelEntry(
  selection: { indices: ReadonlySet<number>; anchor: number | null },
  index: number,
  extend: boolean,
): { indices: Set<number>; anchor: number } {
  const indices = new Set(selection.indices);
  const anchor = selection.anchor;
  if (extend && anchor !== null) {
    for (let i = Math.min(anchor, index); i <= Math.max(anchor, index); i++) indices.add(i);
    return { indices, anchor };
  }
  if (indices.has(index)) indices.delete(index);
  else indices.add(index);
  return { indices, anchor: index };
}

export function removeModelEntries(config: ModelsJson, providerName: string, indices: Iterable<number>): ModelsJson {
  const providers = config.providers;
  const provider = providers?.[providerName];
  if (!provider?.models) return config;
  const models = [...provider.models];
  const removal = [...new Set(indices)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < models.length)
    .sort((a, b) => b - a);
  if (!removal.length) return config;
  for (const index of removal) models.splice(index, 1);
  return { ...config, providers: { ...providers, [providerName]: { ...provider, models: models.length ? models : undefined } } };
}

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
  return patchCompat(entry, { [key]: value });
}

/** Sets compat keys; `undefined` removes one, and an emptied compat is dropped. */
export function patchCompat<T extends CompatEntry>(entry: T, patch: Record<string, unknown>): T {
  const compat = { ...(entry.compat ?? {}), ...patch };
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete compat[key];
  const next: CompatEntry = { ...entry, compat };
  if (!Object.keys(compat).length) delete next.compat;
  return next as T;
}

// Compat can be configured at the provider or model level; pi merges them
// (model wins) at runtime, so switches read the effective value.
export function effectiveCompat(provider: CompatEntry, model: CompatEntry): Record<string, unknown> {
  return { ...(provider.compat ?? {}), ...(model.compat ?? {}) };
}

/** A model-level setting pi otherwise auto-detects per host: "default" leaves it to pi. */
export type CompatChoice = "default" | "on" | "off";

export function compatBoolChoice(entry: CompatEntry, key: string): CompatChoice {
  const value = entry.compat?.[key];
  return value === true ? "on" : value === false ? "off" : "default";
}

export function setCompatBoolChoice<T extends CompatEntry>(entry: T, key: string, choice: CompatChoice): T {
  return patchCompat(entry, { [key]: choice === "default" ? undefined : choice === "on" });
}

/** pi's DeepSeek request format; `reasoning_content` must be replayed with it. */
const DEEPSEEK_THINKING_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
};

export function deepseekThinkingChoice(entry: CompatEntry): CompatChoice {
  const format = entry.compat?.thinkingFormat;
  return format === "deepseek" ? "on" : format === undefined ? "default" : "off";
}

export function setDeepseekThinkingChoice<T extends CompatEntry>(entry: T, choice: CompatChoice): T {
  // "Off" also covers other formats (zai, qwen…); re-picking it must not rewrite them.
  if (choice === deepseekThinkingChoice(entry)) return entry;
  if (choice === "on") return patchCompat(entry, DEEPSEEK_THINKING_COMPAT);
  if (choice === "off") return patchCompat(entry, { thinkingFormat: "openai", requiresReasoningContentOnAssistantMessages: false });
  return patchCompat(entry, { thinkingFormat: undefined, requiresReasoningContentOnAssistantMessages: undefined });
}

/** Compat keys the model page shows under Capabilities rather than Advanced. */
export const THINKING_COMPAT_KEYS = ["forceAdaptiveThinking", "thinkingFormat", "requiresReasoningContentOnAssistantMessages"];

export type ThinkingLevelMap = Record<string, string | null>;
export type ThinkingLevelState = "unsupported" | "supported" | "custom";

// pi offers xhigh/max only with an entry; every other level is offered unless null.
const LEVELS_NEEDING_ENTRY = new Set(["xhigh", "max"]);

/** What pi does with a level (getSupportedThinkingLevels), not how the map spells it. */
export function thinkingLevelState(map: ThinkingLevelMap | undefined, level: string): ThinkingLevelState {
  const value = map?.[level];
  if (value === null) return "unsupported";
  if (value === undefined) return LEVELS_NEEDING_ENTRY.has(level) ? "unsupported" : "supported";
  return value === level ? "supported" : "custom";
}

/**
 * `explicit` is for built-in model overrides: pi merges an override map over the
 * shipped one, so a removed entry would bring the shipped value back.
 */
export function setThinkingLevelState(
  map: ThinkingLevelMap | undefined,
  level: string,
  state: ThinkingLevelState,
  explicit = false,
): ThinkingLevelMap | undefined {
  const next = { ...map };
  if (state === "unsupported") next[level] = null;
  else if (state === "custom") next[level] = typeof next[level] === "string" ? next[level] : level;
  // "off" is never written as is: pi would send it as the provider's effort value.
  else if ((explicit && level !== "off") || LEVELS_NEEDING_ENTRY.has(level)) next[level] = level;
  else delete next[level];
  return Object.keys(next).length ? next : undefined;
}

/**
 * Fill: the source wins for every field it knows, since a user fills to match
 * it. Fields it does not know stay. The display name is the exception: it is
 * the user's own label, filled only when empty.
 */
export function applyCatalogPreset<T extends CompatEntry & {
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}>(model: T, preset: ModelCatalogPreset): { model: T; changedCount: number } {
  let next = { ...model };
  if (!model.name?.trim() && preset.name) next.name = preset.name;
  // The editor stores "no reasoning" as an absent key.
  if (preset.reasoning !== undefined) next.reasoning = preset.reasoning || undefined;
  if (preset.input?.length) next.input = [...preset.input];
  if (preset.contextWindow !== undefined) next.contextWindow = preset.contextWindow;
  if (preset.maxTokens !== undefined) next.maxTokens = preset.maxTokens;
  if (preset.cost) next.cost = { ...model.cost, ...preset.cost };
  if (next.reasoning) {
    // null: pi's own model uses pi's defaults, so a stale map goes.
    if (preset.thinkingLevelMap !== undefined) next.thinkingLevelMap = preset.thinkingLevelMap ? { ...preset.thinkingLevelMap } : undefined;
    // shortcut: a provider-level thinking key still applies after Fill; neutralize it here if that ever matters.
    if (preset.compat) {
      next = patchCompat(next, {
        ...Object.fromEntries(THINKING_COMPAT_KEYS.map((key) => [key, undefined])),
        ...preset.compat,
      });
    }
  }
  // These values are flat; sorted entries make key order irrelevant.
  const canonical = (value: unknown) => JSON.stringify(isRecord(value) ? Object.entries(value).sort(([a], [b]) => a.localeCompare(b)) : value);
  const fields = ["name", "reasoning", "input", "contextWindow", "maxTokens", "cost", "thinkingLevelMap", "compat"] as const;
  const changedCount = fields.filter((key) => canonical(next[key]) !== canonical(model[key])).length;
  return { model: next, changedCount };
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

/**
 * Fill for a provider's list: each model with a recommendation (by id) gets
 * `applyCatalogPreset`; unchanged models keep their object so row keys stay.
 * `unmatched` counts models neither models.dev nor pi's shipped models know.
 */
export function applyCatalogPresetsById<T extends { id: string } & Parameters<typeof applyCatalogPreset>[0]>(
  models: readonly T[],
  recommendations: ReadonlyMap<string, ModelCatalogRecommendation | null>,
): { models: T[]; updated: number; unmatched: number; replaced: [T, T][] } {
  let updated = 0;
  let unmatched = 0;
  const replaced: [T, T][] = [];
  const next = models.map((model) => {
    if (!recommendations.has(model.id)) return model;
    const recommendation = recommendations.get(model.id);
    // pi's own model always answers with a compat set (possibly empty).
    if (!recommendation || (recommendation.exactMatches === 0 && recommendation.preset.compat === undefined)) {
      unmatched += 1;
      return model;
    }
    const filled = applyCatalogPreset(model, recommendation.preset);
    if (!filled.changedCount) return model;
    updated += 1;
    replaced.push([model, filled.model]);
    return filled.model;
  });
  return { models: next, updated, unmatched, replaced };
}
