export const SUBAGENT_POOL_SWITCH_TYPE = "pi-web:subagent-pool-switch";

export type SubagentPoolSwitchReason = "auth" | "quota" | "transient" | "timeout";

export interface SubagentPoolSwitchData {
  version: 1;
  from: { provider: string; id: string };
  to: { provider: string; id: string };
  error: string;
  reason: SubagentPoolSwitchReason;
  memberIndex: number;
}

export function modelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export function uniqueModelRefs(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const ref = value.trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/** Ordered pool refs for a profile. Empty means inherit the parent session model. */
export function profilePool(profile: { model?: string; models?: readonly string[] }): string[] {
  const model = profile.model?.trim() || undefined;
  const listed = uniqueModelRefs(profile.models?.length ? profile.models : (model ? [model] : []));
  if (model && listed[0] !== model) return uniqueModelRefs([model, ...listed]);
  return listed;
}

/** Disk shape: one item writes only `model:`; several write `model:` plus `models:` with `model === models[0]`. */
export function serializeProfilePool(profile: { model?: string; models?: readonly string[] }): {
  model?: string;
  models?: string[];
} {
  const pool = profilePool(profile);
  if (pool.length === 0) return {};
  if (pool.length === 1) return { model: pool[0] };
  return { model: pool[0], models: pool };
}
