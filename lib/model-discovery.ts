const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];

export interface DiscoveredModel {
  id: string;
  name?: string;
  // Capabilities the upstream list publishes, as models.json fields.
  reasoning?: true;
  thinkingLevelMap?: Partial<Record<EffortLevel | "off", string | null>>;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
}

// Only fields whose meaning does not vary between gateways. `max_tokens` is
// left out: LiteLLM, for one, fills it with either the input or output limit.
const CONTEXT_WINDOW_FIELDS = [
  "context_length", "contextLength", "context_window", "contextWindow",
  "max_model_len", "max_input_tokens", "inputTokenLimit",
];
const MAX_TOKENS_FIELDS = ["max_output_tokens", "maxOutputTokens", "max_completion_tokens", "outputTokenLimit"];
const REASONING_FIELDS = ["supports_reasoning", "supportsReasoning", "reasoning", "thinking"];
// Pricing is also omitted: gateways disagree on per-token vs per-million units.
const EFFORT_LIST_FIELDS = ["supported_efforts", "supportedEfforts", "reasoning_levels"];
// Cursor-style `parameters: [{ id: "reasoning_effort", values: [{ value }] }]`.
const EFFORT_PARAMETER_IDS = new Set(["reasoning_effort", "reasoningEffort", "effort"]);
const CAN_DISABLE_FIELDS = ["can_disable_thinking", "canDisableThinking"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstPositiveInteger(value: Record<string, unknown>, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const raw = value[field];
    const number = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) return number;
  }
  return undefined;
}

function effortSet(list: unknown[]): Set<string> {
  return new Set(list
    .map((effort) => isRecord(effort) ? effort.value : effort)
    .filter((effort): effort is string => typeof effort === "string"));
}

/** Effort names from a top-level or nested `reasoning` list, else a Cursor-style parameter. */
function advertisedEfforts(value: Record<string, unknown>): Set<string> | undefined {
  for (const source of [value, value.reasoning]) {
    if (!isRecord(source)) continue;
    const list = EFFORT_LIST_FIELDS.map((field) => source[field]).find((entry) => Array.isArray(entry) && entry.length > 0);
    if (list) return effortSet(list as unknown[]);
  }
  if (!Array.isArray(value.parameters)) return undefined;
  const parameter = value.parameters.find((entry) =>
    isRecord(entry) && typeof entry.id === "string" && EFFORT_PARAMETER_IDS.has(entry.id) && Array.isArray(entry.values));
  return parameter ? effortSet(parameter.values as unknown[]) : undefined;
}

/**
 * `off` is mapped only when the gateway says whether thinking can be turned
 * off; a list without none/off does not say it cannot (another parameter may).
 */
function offMapping(value: Record<string, unknown>, efforts: Set<string> | undefined): string | null | undefined {
  const canDisable = CAN_DISABLE_FIELDS.map((field) => value[field]).find((flag) => typeof flag === "boolean");
  if (canDisable === false) return null;
  if (efforts?.has("off")) return "off";
  if (efforts?.has("none") || canDisable) return "none";
  return undefined;
}

/**
 * Advertised pi levels keep no entry, so pi sends the level name; every level
 * left out is unsupported (null), and `xhigh` / `max` need an entry to be
 * offered at all. A list naming none of pi's levels maps no level.
 */
function thinkingLevelMapFrom(value: Record<string, unknown>, efforts: Set<string> | undefined): DiscoveredModel["thinkingLevelMap"] {
  const map: NonNullable<DiscoveredModel["thinkingLevelMap"]> = {};
  if (efforts && EFFORT_LEVELS.some((level) => efforts.has(level))) {
    for (const level of EFFORT_LEVELS) {
      if (!efforts.has(level)) map[level] = null;
      else if (level === "xhigh" || level === "max") map[level] = level;
    }
  }
  const off = offMapping(value, efforts);
  if (off !== undefined) map.off = off;
  return Object.keys(map).length ? map : undefined;
}

function inputModalities(value: Record<string, unknown>): DiscoveredModel["input"] {
  const nested = isRecord(value.modalities) ? value.modalities.input : undefined;
  const list = Array.isArray(nested) ? nested : value.input;
  if (!Array.isArray(list)) return undefined;
  const input = [...new Set(list.map((entry) => typeof entry === "string" ? entry.trim().toLowerCase() : entry)
    .filter((entry): entry is "text" | "image" => entry === "text" || entry === "image"))];
  return input.length ? input : undefined;
}

function capabilitiesFromValue(value: Record<string, unknown>): Omit<DiscoveredModel, "id" | "name"> {
  const efforts = advertisedEfforts(value);
  const reasoning = REASONING_FIELDS.some((field) => value[field] === true)
    || EFFORT_LEVELS.some((level) => efforts?.has(level));
  const thinkingLevelMap = reasoning ? thinkingLevelMapFrom(value, efforts) : undefined;
  const input = inputModalities(value);
  const contextWindow = firstPositiveInteger(value, CONTEXT_WINDOW_FIELDS);
  const maxTokens = firstPositiveInteger(value, MAX_TOKENS_FIELDS);
  return {
    ...(reasoning ? { reasoning: true } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(input ? { input } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };
}

function modelFromValue(value: unknown): DiscoveredModel | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : null;
  }
  if (!isRecord(value)) return null;

  const rawId = cleanString(value.id) ?? cleanString(value.model) ?? cleanString(value.name);
  if (!rawId) return null;
  const id = rawId.startsWith("models/") ? rawId.slice("models/".length) : rawId;
  if (!id) return null;
  const name = cleanString(value.display_name)
    ?? cleanString(value.displayName)
    ?? (cleanString(value.id) || cleanString(value.model) ? cleanString(value.name) : undefined);
  return { id, ...(name && name !== id ? { name } : {}), ...capabilitiesFromValue(value) };
}

function listFromResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["data", "models", "results", "items"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (isRecord(candidate)) return Object.values(candidate);
  }
  return [];
}

export function parseDiscoveredModels(value: unknown): DiscoveredModel[] {
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const item of listFromResponse(value)) {
    const model = modelFromValue(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

export function buildModelsListUrl(baseUrl: string, api: string): URL {
  const url = new URL(baseUrl.trim());
  const trimmedPath = url.pathname.replace(/\/+$/, "");

  if (!/\/models$/i.test(trimmedPath)) {
    let path = trimmedPath;
    if (api === "anthropic-messages" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1";
    if (api === "google-generative-ai" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1beta";
    url.pathname = `${path}/models`.replace(/\/+/g, "/");
  }

  if (api === "anthropic-messages" && !url.searchParams.has("limit")) {
    url.searchParams.set("limit", "1000");
  }
  if (api === "google-generative-ai" && !url.searchParams.has("pageSize")) {
    url.searchParams.set("pageSize", "1000");
  }
  return url;
}
