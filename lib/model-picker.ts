export type PickerToggleErrorCode = "project-override" | "glob-managed" | "last-model";

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
  inPicker: boolean;
}

export class PickerToggleError extends Error {
  readonly code: PickerToggleErrorCode;

  constructor(code: PickerToggleErrorCode, message: string) {
    super(message);
    this.name = "PickerToggleError";
    this.code = code;
  }
}

export function modelPickerRef(provider: string, id: string): string {
  return `${provider}/${id}`;
}

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

function patternBase(pattern: string): string {
  return pattern.trim().replace(THINKING_SUFFIX, "");
}

export function isExactProviderPattern(pattern: string, provider: string): boolean {
  const base = patternBase(pattern);
  return Boolean(base) && !/[*?\[]/.test(base) && base.startsWith(`${provider}/`);
}

export function removeExactProviderPatterns(
  patterns: string[] | undefined,
  provider: string,
): string[] {
  return (patterns ?? []).filter((pattern) => !isExactProviderPattern(pattern, provider));
}

export function countExactProviderPatterns(
  patterns: string[] | undefined,
  provider: string,
): number {
  return (patterns ?? []).reduce(
    (count, pattern) => count + (isExactProviderPattern(pattern, provider) ? 1 : 0),
    0,
  );
}

export function applyPickerToggle(input: {
  patterns: string[] | undefined;
  projectHasEnabledModels: boolean;
  availableRefs: readonly string[];
  visibleRefs: readonly string[];
  ref: string;
  inPicker: boolean;
}): { enabledModels: string[] } {
  if (input.projectHasEnabledModels) {
    throw new PickerToggleError(
      "project-override",
      "enabledModels is set in project settings and cannot be changed here",
    );
  }

  const patterns = (input.patterns ?? []).map((pattern) => pattern.trim()).filter(Boolean);
  const hasExact = patterns.includes(input.ref);

  if (input.inPicker) {
    if (patterns.length === 0 || hasExact || input.visibleRefs.includes(input.ref)) {
      return { enabledModels: patterns };
    }
    return { enabledModels: [...patterns, input.ref] };
  }

  if (patterns.length === 0) {
    const next = input.availableRefs.filter((ref) => ref !== input.ref);
    if (next.length === 0) {
      throw new PickerToggleError("last-model", "Hiding this model would leave the picker empty");
    }
    return { enabledModels: next };
  }

  if (hasExact) {
    const next = patterns.filter((pattern) => pattern !== input.ref);
    if (next.length === 0) {
      throw new PickerToggleError("last-model", "Hiding this model would leave the picker empty");
    }
    return { enabledModels: next };
  }

  throw new PickerToggleError(
    "glob-managed",
    "This model is included by an enabledModels glob; edit settings.json",
  );
}

export function samePickerPatterns(
  current: string[] | undefined,
  next: string[],
): boolean {
  const left = (current ?? []).map((pattern) => pattern.trim()).filter(Boolean);
  return left.length === next.length && left.every((pattern, index) => pattern === next[index]);
}
