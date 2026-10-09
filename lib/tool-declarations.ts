import type { AgentSessionLike } from "./pi-types";
import type { ToolEntry } from "./tool-presets";

export type ModelToolEntry = ToolEntry & { declarationHidden?: boolean };

/** The public state holds prepareLoadout's descriptions; hidden declarations have no public getter. */
export function getModelToolEntries(session: AgentSessionLike): ModelToolEntry[] {
  const active = new Set(session.getActiveToolNames());
  const state = session.agent.state as { tools?: Array<{ name: string; description: string; parameters?: Record<string, unknown> }> } | undefined;
  const declared = new Map((state?.tools ?? []).map((tool) => [tool.name, tool]));
  let hidden = new Set<string>();
  // SDK compatibility guard: an absent/changed private field preserves the previous panel behavior.
  try {
    const value = (session as unknown as { _hiddenDeclarations?: unknown })._hiddenDeclarations;
    if (value instanceof Set && [...value].every((name) => typeof name === "string")) hidden = value;
  } catch {
    // Future SDKs may replace the field with a throwing getter.
  }
  return session.getAllTools().map((tool) => {
    const modelTool = active.has(tool.name) ? declared.get(tool.name) : undefined;
    return {
      ...tool,
      description: modelTool?.description ?? tool.description,
      parameters: (modelTool?.parameters ?? tool.parameters) as Record<string, unknown> | undefined,
      active: active.has(tool.name),
      declarationHidden: hidden.has(tool.name),
    };
  });
}
