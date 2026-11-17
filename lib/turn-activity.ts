import { getImageGenerationResult, IMAGE_TOOL_NAME } from "./image-generation";
import { thinkingDurationSeconds } from "./message-display";
import { isApplyPatchToolName, isEditToolName, isWriteToolName } from "./tool-names";
import type { AssistantMessage, ToolResultMessage } from "./types";

export interface TurnActivity {
  commands: number;
  /** codemode runs; shown beside commands under one "Ran". */
  scripts: number;
  explored: boolean;
  researched: boolean;
  subagents: number;
  images: number;
  /** Successful calls outside every category above (MCP and other extension tools). */
  tools: number;
  /** The turn reasoned; the header mentions it only when nothing else happened. */
  thought: boolean;
  /** Summed thinking time in seconds, as the thinking rows show it; 0 when unknown. */
  thoughtSeconds: number;
}

const EXPLORE_TOOLS = new Set(["read", "grep", "find", "ls"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);
const SCRIPT_TOOLS = new Set(["codemode"]);
// Covered elsewhere: written files by `extractTurnWrittenFiles`, subagent follow-ups by the Agent count.
const SKIP_TOOLS = new Set(["get_subagent_result", "steer_subagent", "abort_subagent"]);
// ponytail: pi-web-access and pi-kit web.ts names only; other web tools stay uncounted.
const WEB_TOOLS = new Set(["web_search", "web_fetch", "fetch_content", "get_search_content", "source_check", "code_search", "x_search"]);

/**
 * What a settled turn did, from tool calls that returned. Commands, scripts,
 * subagents and images are counted; exploring and web research are yes/no. Any
 * other successful call counts as a generic tool, so MCP and extension tools are
 * not silently dropped. Changed
 * files come from `extractTurnWrittenFiles`, not from here.
 */
export function summarizeTurnActivity(
  messages: Pick<AssistantMessage, "content" | "timestamp" | "completedAt">[],
  toolResults: Map<string, ToolResultMessage> | undefined,
): TurnActivity {
  const activity: TurnActivity = { commands: 0, scripts: 0, explored: false, researched: false, subagents: 0, images: 0, tools: 0, thought: false, thoughtSeconds: 0 };
  for (const message of messages) for (const block of message.content) {
    if (block.type === "thinking") {
      if (!block.deferred && !block.thinking.trim()) continue;
      activity.thought = true;
      activity.thoughtSeconds += thinkingDurationSeconds(block, message) ?? 0;
      continue;
    }
    if (block.type !== "toolCall") continue;
    const result = toolResults?.get(block.toolCallId);
    if (!result) continue;
    const name = block.toolName;
    // A failed command or script still ran; a failed read or search found nothing.
    if (COMMAND_TOOLS.has(name)) activity.commands += 1;
    else if (SCRIPT_TOOLS.has(name)) activity.scripts += 1;
    if (COMMAND_TOOLS.has(name) || SCRIPT_TOOLS.has(name) || result.isError) continue;
    if (EXPLORE_TOOLS.has(name)) activity.explored = true;
    else if (WEB_TOOLS.has(name)) activity.researched = true;
    else if (name === "Agent") activity.subagents += 1;
    else if (name === IMAGE_TOOL_NAME) { if (getImageGenerationResult(result.details)) activity.images += 1; }
    else if (!SKIP_TOOLS.has(name) && !isWriteToolName(name) && !isEditToolName(name) && !isApplyPatchToolName(name)) activity.tools += 1;
  }
  return activity;
}
