export interface SubagentPromptPlan {
  chatOnly: boolean;
  appendSystemPrompt: string[];
  delegatedTask: string;
  exactSystemPrompt?: string;
}

export function buildSubagentPromptPlan(options: {
  profileSystemPrompt: string;
  projectInstructions?: string;
  tools: readonly string[];
  loadSkills?: boolean;
  loadExtensions?: boolean;
  promptMode?: "replace" | "append";
  task: string;
  inheritedParentContext?: string;
}): SubagentPromptPlan {
  const chatOnly = options.tools.length === 0 && !options.loadSkills && !options.loadExtensions;
  const replacePrompt = options.promptMode === "replace";
  const appendSystemPrompt = [
    options.profileSystemPrompt,
    ...(!replacePrompt && options.projectInstructions ? [options.projectInstructions] : []),
  ].filter((part): part is string => Boolean(part?.trim()));
  if (options.inheritedParentContext && !chatOnly) {
    appendSystemPrompt.push(options.inheritedParentContext);
  }
  return {
    chatOnly,
    appendSystemPrompt,
    delegatedTask: options.inheritedParentContext && chatOnly
      ? `${options.task}\n\n${options.inheritedParentContext}`
      : options.task,
    ...(chatOnly || replacePrompt ? { exactSystemPrompt: appendSystemPrompt.join("\n\n") } : {}),
  };
}
