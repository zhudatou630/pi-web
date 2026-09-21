import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import stripJsonComments from "strip-json-comments";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { invalidateModelsCache } from "./models-cache";

const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelCost(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const providedKeys = MODEL_COST_KEYS.filter((key) => value[key] !== undefined);
  if (providedKeys.length === 0) return undefined;
  if (providedKeys.some((key) => (
    typeof value[key] !== "number" || !Number.isFinite(value[key])
  ))) return undefined;

  return Object.fromEntries([
    ...Object.entries(value),
    ...MODEL_COST_KEYS.map((key) => [key, value[key] ?? 0]),
  ]);
}

/** Complete partial cost groups with zero; omit a cost group only when it is empty. */
export function normalizeModelsConfigCosts(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = structuredClone(data);
  if (!isRecord(normalized.providers)) return normalized;

  for (const provider of Object.values(normalized.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || !("cost" in model)) continue;
      const cost = normalizeModelCost(model.cost);
      if (cost) model.cost = cost;
      else delete model.cost;
    }
  }
  return normalized;
}

function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));

  return { ...data, providers };
}

export function getModelsConfigPath(): string {
  return join(getAgentDir(), "models.json");
}

/**
 * Parse `models.json` the way the SDK's `ModelConfig.load` does: JSON with
 * comments and trailing commas. Strict `JSON.parse` silently returned an empty
 * config for a hand-edited file, and the next save then overwrote the user's
 * real providers with that empty object.
 */
const TRAILING_COMMA = /,(\s*[}\]])/g;

function parseModelsConfigContent(content: string): Record<string, unknown> {
  const parsed = JSON.parse(
    stripJsonComments(content).replace(TRAILING_COMMA, "$1"),
  ) as Record<string, unknown>;
  if (!isRecord(parsed)) throw new Error("Invalid models.json: expected an object");
  return parsed;
}

/**
 * Read `models.json`.
 *
 * Returns `{ providers: {} }` only when the file does not exist. Content that
 * cannot be parsed is reported instead of swallowed: callers must refuse to
 * save over a file they could not read.
 */
export function readModelsConfigResult(
  modelsPath = getModelsConfigPath(),
): { config: Record<string, unknown>; error?: string } {
  if (!existsSync(modelsPath)) return { config: { providers: {} } };
  try {
    return { config: parseModelsConfigContent(readFileSync(modelsPath, "utf8")) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: { providers: {} },
      error: `Failed to read ${modelsPath}: ${message}`,
    };
  }
}

export function readModelsConfig(
  modelsPath = getModelsConfigPath(),
): Record<string, unknown> {
  return readModelsConfigResult(modelsPath).config;
}

export class ModelsConfigReadError extends Error {
  constructor() {
    super("models.json could not be parsed; refusing to overwrite it");
    this.name = "ModelsConfigReadError";
  }
}

export function writeModelsConfig(
  data: Record<string, unknown>,
  modelsPath = getModelsConfigPath(),
): void {
  if (existsSync(modelsPath) && readModelsConfigResult(modelsPath).error) {
    throw new ModelsConfigReadError();
  }
  const dir = dirname(modelsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const normalized = normalizeModelsConfigCosts(sanitizeModelsConfig(reconcileModelOverrides(data)));
  writePrivateFileAtomicSync(modelsPath, JSON.stringify(normalized, null, 2));
  invalidateModelsCache();
}

/**
 * Keep only the leaf keys of `overrideValue` that `definitionValue` does not set.
 *
 * The SDK merges an override over its definition one leaf at a time
 * (`applyModelOverride` copies `cost.input`, `cost.output`, `thinkingLevelMap.off`
 * … individually), so `{ cost: { input: 99 } }` still wins for `input` alone and
 * leaves the definition's `output`/`cacheRead` in effect. Reconciling whole
 * objects would drop leaves that still apply.
 *
 * A scalar (either side) is replaced outright: `undefined` means "the definition
 * already states this, and the override loses".
 */
function pruneOverrideLeaves(overrideValue: unknown, definitionValue: unknown): unknown {
  if (!isRecord(overrideValue) || !isRecord(definitionValue)) return undefined;
  const kept = Object.fromEntries(
    Object.entries(overrideValue).filter(([key]) => definitionValue[key] === undefined),
  );
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * Remove from every `modelOverrides` entry the fields its `models[]` definition
 * also sets.
 *
 * The SDK resolves an override over its definition, but the Models panel edits
 * and displays only the definition — so a field present in both silently ignored
 * every edit made in the panel. Saving converges the layers: the definition owns
 * the fields it states, and override-only fields keep applying to the catalog
 * model underneath.
 */
export function reconcileModelOverrides(
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !isRecord(provider.modelOverrides) || !Array.isArray(provider.models)) {
      return [providerId, provider];
    }

    const next: Record<string, unknown> = { ...provider.modelOverrides };
    for (const model of provider.models) {
      const id = isRecord(model) ? model.id : undefined;
      if (typeof id !== "string" || id.length === 0) continue;
      const override = next[id];
      if (!isRecord(override)) continue;

      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(override)) {
        // `id` identifies the entry; it is never an override field.
        if (key === "id") continue;
        const definitionValue = model[key];
        // A field the definition does not mention stays with the override.
        if (definitionValue === undefined) {
          kept[key] = value;
          continue;
        }
        const pruned = pruneOverrideLeaves(value, definitionValue);
        if (pruned !== undefined) kept[key] = pruned;
      }

      if (Object.keys(kept).length > 0) next[id] = kept;
      else delete next[id];
    }

    const nextProvider: Record<string, unknown> = { ...provider, modelOverrides: next };
    if (Object.keys(next).length === 0) delete nextProvider.modelOverrides;
    return [providerId, nextProvider];
  }));

  return { ...data, providers };
}
