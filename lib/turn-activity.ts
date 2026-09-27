import { getImageGenerationResult, IMAGE_TOOL_NAME } from "./image-generation";
import type { AssistantContentBlock, ToolResultMessage } from "./types";

export interface TurnActivity {
  commands: number;
  explored: boolean;
  researched: boolean;
  subagents: number;
  images: number;
  /** The turn reasoned; the header mentions it only when nothing else happened. */
  thought: boolean;
}

const EXPLORE_TOOLS = new Set(["read", "grep", "find", "ls"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);
// ponytail: pi-web-access default names only; renamed or third-party web tools stay uncounted.
const WEB_TOOLS = new Set(["web_search", "fetch_content", "get_search_content", "source_check", "code_search", "x_search"]);

/**
 * What a settled turn did, from tool calls that returned. Commands, subagents
 * and images are counted; exploring and web research are yes/no. Unknown tools
 * stay out of the summary instead of being guessed into a category. Changed
 * files come from `extractTurnWrittenFiles`, not from here.
 */
export function summarizeTurnActivity(
  content: AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage> | undefined,
): TurnActivity {
  const activity: TurnActivity = { commands: 0, explored: false, researched: false, subagents: 0, images: 0, thought: false };
  for (const block of content) {
    if (block.type === "thinking") {
      activity.thought ||= Boolean(block.deferred || block.thinking.trim());
      continue;
    }
    if (block.type !== "toolCall") continue;
    const result = toolResults?.get(block.toolCallId);
    if (!result) continue;
    const name = block.toolName;
    // A failed command still ran; a failed read or search found nothing.
    if (COMMAND_TOOLS.has(name)) activity.commands += 1;
    if (result.isError) continue;
    if (EXPLORE_TOOLS.has(name)) activity.explored = true;
    else if (WEB_TOOLS.has(name)) activity.researched = true;
    else if (name === "Agent") activity.subagents += 1;
    else if (name === IMAGE_TOOL_NAME && getImageGenerationResult(result.details)) activity.images += 1;
  }
  return activity;
}
