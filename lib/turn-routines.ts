import type { AssistantContentBlock, ToolResultMessage } from "./types";

export interface CreatedRoutine {
  id: string;
  name: string;
  action: "created" | "updated";
}

/** Successful routine creations and updates, deduplicated in call order; creation wins. */
export function extractTurnCreatedRoutines(
  content: AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage> | undefined,
): CreatedRoutine[] {
  const routines = new Map<string, CreatedRoutine>();
  for (const block of content) {
    // `update_routine`: older chats, before it merged into `routines`.
    if (block.type !== "toolCall" || !["create_routine", "routines", "update_routine"].includes(block.toolName)) continue;
    const result = toolResults?.get(block.toolCallId);
    const details = result?.details as { created?: unknown; updated?: unknown; routineId?: unknown; name?: unknown } | undefined;
    const action = block.toolName === "create_routine" ? "created" : "updated";
    if (result?.isError || details?.[action] !== true || typeof details.routineId !== "string") continue;
    if (routines.get(details.routineId)?.action === "created") continue;
    const name = action === "created" ? block.input?.name : details.name;
    routines.set(details.routineId, { id: details.routineId, name: typeof name === "string" ? name : details.routineId, action });
  }
  return [...routines.values()];
}
