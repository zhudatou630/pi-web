import { THINKING_SUFFIX } from "./thinking-levels";

export interface RuntimeCatalogModel {
  provider: string;
  id: string;
  name: string;
  api?: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export type EnabledModelsSource = "none" | "global" | "project";

/** The `enabledModels` key as stored, not the models it resolves to. */
export interface EnabledModelsDocument {
  source: EnabledModelsSource;
  patterns: string[];
  readOnly: boolean;
}

/**
 * The document plus what it resolves to. The panel renders the resolved list,
 * so globs, bare ids, and thinking pins stay in the file instead of the UI.
 */
export interface EnabledModelsPanelState extends EnabledModelsDocument {
  visible: { provider: string; id: string }[];
  pins: Record<string, string>;
  /**
   * Every model the definition layers know, credentials aside. Comparing two
   * reads of this set tells the panel whether a definition disappeared, which
   * is the only evidence that justifies editing the list on the user's behalf.
   */
  defined: string[];
  /** Exact patterns the resolver could not settle, e.g. an ambiguous bare id. */
  ambiguous?: string[];
}

export function modelPickerRef(provider: string, id: string): string {
  return `${provider}/${id}`;
}

export function normalizePatterns(patterns: readonly string[] | undefined): string[] {
  return (patterns ?? []).map((pattern) => pattern.trim()).filter(Boolean);
}

/** Empty means delete the key. `[]` and a missing key both resolve to every model, but a present `[]` still overrides. */
export function patternsToStore(patterns: readonly string[]): string[] | undefined {
  const next = normalizePatterns(patterns);
  return next.length > 0 ? next : undefined;
}

export function appendExactRef(patterns: readonly string[], ref: string): string[] {
  const next = normalizePatterns(patterns);
  const exact = ref.trim();
  if (!exact || next.includes(exact)) return next;
  return [...next, exact];
}

export function samePickerPatterns(
  current: readonly string[] | undefined,
  next: readonly string[],
): boolean {
  return JSON.stringify(normalizePatterns(current)) === JSON.stringify(normalizePatterns(next));
}

export function describeEnabledModels(input: {
  globalPatterns: readonly string[] | undefined;
  globalHasKey: boolean;
  projectPatterns: readonly string[] | undefined;
  projectHasKey: boolean;
  projectWritable: boolean;
}): EnabledModelsDocument {
  if (input.projectHasKey) {
    return {
      source: "project",
      patterns: normalizePatterns(input.projectPatterns),
      readOnly: !input.projectWritable,
    };
  }
  if (input.globalHasKey) {
    return { source: "global", patterns: normalizePatterns(input.globalPatterns), readOnly: false };
  }
  return { source: "none", patterns: [], readOnly: false };
}

/** A project-local key can only be written when the workspace is trusted. */
export function enabledModelsWriteScope(source: EnabledModelsSource): "global" | "project" {
  return source === "project" ? "project" : "global";
}

export interface ExactRef {
  /** Absent for a bare model id, which names no provider. */
  provider?: string;
  id: string;
  pin?: string;
  /** Canonical `provider/id` when the pattern states one, else the bare id. */
  ref: string;
}

/**
 * A pattern that names one model rather than a glob. `provider/id` and a bare
 * `id` are both exact; only the file's glob/fuzzy rules are not.
 */
export function exactRefOf(pattern: string): ExactRef | null {
  const trimmed = pattern.trim();
  const match = trimmed.match(THINKING_SUFFIX);
  const base = match ? trimmed.slice(0, -match[0].length) : trimmed;
  const pin = match?.[1];
  if (!base || /[*?\[]/.test(base)) return null;
  const slash = base.indexOf("/");
  // A trailing slash names no model; everything else is exact, including a
  // bare id that no provider prefix qualifies.
  if (slash === base.length - 1) return null;
  if (slash <= 0) {
    return { id: base, ...(pin ? { pin } : {}), ref: base };
  }
  return {
    provider: base.slice(0, slash),
    id: base.slice(slash + 1),
    ...(pin ? { pin } : {}),
    ref: base,
  };
}

export function removeExactRef(patterns: readonly string[], ref: string): string[] {
  const target = ref.trim();
  // The panel names models canonically (`provider/id`), but a list may hold the
  // bare id form, which names the same model.
  const targetId = target.slice(target.indexOf("/") + 1);
  return normalizePatterns(patterns).filter((pattern) => {
    const exact = exactRefOf(pattern);
    if (exact === null) return true;
    if (exact.ref === target) return false;
    return exact.provider !== undefined || exact.id !== targetId;
  });
}

export function removePattern(patterns: readonly string[], pattern: string): string[] {
  const target = pattern.trim();
  return normalizePatterns(patterns).filter((item) => item !== target);
}

/**
 * Exact patterns in the file that name no visible model. Chat ignores them, but
 * they still occupy the list, so the panel shows them and offers removal.
 *
 * A bare id is included when no visible model carries that id: the entry is
 * just as dead as an unqualified one, and hiding it would leave the user
 * editing settings.json by hand.
 */
export function unresolvedPatterns(input: {
  patterns: readonly string[];
  visible: readonly string[];
}): string[] {
  const visibleRefs = new Set(input.visible);
  const visibleIds = new Set(input.visible.map((ref) => ref.slice(ref.indexOf("/") + 1)));
  return normalizePatterns(input.patterns).filter((pattern) => {
    const exact = exactRefOf(pattern);
    if (exact === null) return false;
    if (!exact.provider) return !visibleIds.has(exact.id);
    return !visibleRefs.has(exact.ref);
  });
}

/**
 * Exact patterns whose model disappeared from a definition layer between two
 * reads, regardless of credentials.
 *
 * `before` and `after` are each `provider/id` sets built from the credential-
 * blind model list, so a signed-out or briefly unreachable provider does not
 * look like a deleted definition. Returns the patterns themselves so the caller
 * can remove exactly those entries.
 */
export function definitionsLost(input: {
  patterns: readonly string[];
  before: ReadonlySet<string>;
  after: ReadonlySet<string>;
}): string[] {
  return normalizePatterns(input.patterns).filter((pattern) => {
    const exact = exactRefOf(pattern);
    return exact !== null
      && exact.provider !== undefined
      && input.before.has(exact.ref)
      && !input.after.has(exact.ref);
  });
}

/** A list of exact lines can lose one without rewriting the others. */
export function isExactList(patterns: readonly string[]): boolean {
  const list = normalizePatterns(patterns);
  return list.length > 0 && list.every((pattern) => exactRefOf(pattern) !== null);
}

/**
 * The `enabledModels` value that removes one model from what chat shows.
 *
 * An exact list loses that line, and an empty result is returned as-is so the
 * caller can refuse it — an empty list deletes the key, which means every
 * model. Only a glob or fuzzy pattern, which cannot say "not this one", is
 * rewritten as the models it currently covers, keeping the pinned levels.
 */
export function removeVisibleModel(input: {
  patterns: readonly string[];
  visible: readonly string[];
  pins: Readonly<Record<string, string>>;
  ref: string;
}): string[] {
  const patterns = normalizePatterns(input.patterns);
  if (isExactList(patterns)) return removeExactRef(patterns, input.ref);
  return input.visible
    .filter((ref) => ref !== input.ref)
    .map((ref) => `${ref}${input.pins[ref] ? `:${input.pins[ref]}` : ""}`);
}
