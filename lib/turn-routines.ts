import type { AssistantContentBlock, ToolResultMessage } from "./types";

export interface CreatedRoutine {
  id: string;
  name: string;
}

/** The routines a turn created with `create_routine` (approved and saved), in call order. */
export function extractTurnCreatedRoutines(
  content: AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage> | undefined,
): CreatedRoutine[] {
  const routines: CreatedRoutine[] = [];
  for (const block of content) {
    if (block.type !== "toolCall" || block.toolName !== "create_routine") continue;
    const details = toolResults?.get(block.toolCallId)?.details as { created?: unknown; routineId?: unknown } | undefined;
    if (details?.created !== true || typeof details.routineId !== "string") continue;
    const name = typeof block.input?.name === "string" ? block.input.name : details.routineId;
    routines.push({ id: details.routineId, name });
  }
  return routines;
}
