import type { SubagentProfile, SubagentScope } from "./subagents";

const SUBAGENT_SCOPE_PRIORITY: Record<SubagentScope, number> = {
  builtin: 0,
  global: 1,
  workspace: 2,
  project: 3,
};

/**
 * Every definition of one agent name, highest precedence first. The first entry is the
 * effective one and wins whole: lower entries never fill in, even when it is disabled.
 */
export function subagentProfileSources<T extends Pick<SubagentProfile, "name" | "scope">>(
  profiles: readonly T[],
  name: string,
): T[] {
  const key = name.toLowerCase();
  return profiles
    .filter((profile) => profile.name.toLowerCase() === key)
    .sort((a, b) => SUBAGENT_SCOPE_PRIORITY[b.scope] - SUBAGENT_SCOPE_PRIORITY[a.scope]);
}
