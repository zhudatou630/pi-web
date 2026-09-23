import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export interface ContextFileContent {
  path: string;
  content: string;
}

/** Preserve Pi's discovery order and include only the context-file contents. */
export function contextFilesSystemPrompt(files: readonly ContextFileContent[]): string {
  return files.map((file) => file.content).join("\n\n");
}

export function createExactSystemPromptExtension(systemPrompt: string | (() => string)): InlineExtension {
  const getPrompt = typeof systemPrompt === "function" ? systemPrompt : () => systemPrompt;
  return {
    name: "pi-web-exact-system-prompt",
    hidden: true,
    factory: (pi) => {
      // Resolved per run: a reload re-reads the context files, and a Chat-only
      // session created by a subagent must not carry a stale parent prompt.
      pi.on("before_agent_start", () => ({ systemPrompt: getPrompt() }));
    },
  };
}
