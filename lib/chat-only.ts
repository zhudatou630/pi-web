import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export interface ContextFileContent {
  path: string;
  content: string;
}

/** Preserve Pi's discovery order and include only the context-file contents. */
export function contextFilesSystemPrompt(files: readonly ContextFileContent[]): string {
  return files.map((file) => file.content).join("\n\n");
}

export function createExactSystemPromptExtension(systemPrompt: string): InlineExtension {
  return {
    name: "pi-web-exact-system-prompt",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", () => ({ systemPrompt }));
    },
  };
}
