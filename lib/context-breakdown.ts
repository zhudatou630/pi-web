import { statSync } from "node:fs";
import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { buildSessionContext, estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Estimated composition of the context the next request would carry, in pi's own
 * chars/4 units. Only proportions are meaningful: the client scales them to the
 * reported token count.
 */
export interface ContextBreakdown {
  /** Fixed overhead: the replayed system prompt, including context files and the skills list. */
  systemPrompt: number;
  /** Fixed overhead: tool declarations sent with every request. */
  tools: number;
  /** Grows with work: user, assistant (text, thinking, tool calls), summaries and other messages. */
  conversation: number;
  /** Grows with work: tool output returned to the model. */
  toolResults: number;
}

type ContextMessage = ReturnType<typeof buildSessionContext>["messages"][number];

function chars(text: string | undefined | null): number {
  return text ? text.length : 0;
}

export function computeContextBreakdown(messages: readonly ContextMessage[]): ContextBreakdown {
  const result: ContextBreakdown = { systemPrompt: 0, tools: 0, conversation: 0, toolResults: 0 };

  // Replaying every system message yields the current prompt and tool set; the
  // individual system messages are patches and must not be counted again.
  const system = getCurrentSystemMessage(messages);
  if (system) {
    let systemChars = typeof system.content === "string"
      ? chars(system.content)
      : system.content.reduce((sum, block) => sum + chars(block.text), 0);
    for (const body of Object.values(system.sections ?? {})) systemChars += chars(body);
    result.systemPrompt = Math.ceil(systemChars / 4);
    const tools = getCurrentTools(messages);
    if (tools.length > 0) result.tools = Math.ceil(JSON.stringify(tools).length / 4);
  }

  for (const message of messages) {
    if (message.role === "system") continue;
    // `!!` commands stay in the transcript but convertToLlm() never sends them.
    if (message.role === "bashExecution" && message.excludeFromContext) continue;
    const tokens = estimateTokens(message);
    if (message.role === "toolResult") result.toolResults += tokens;
    else result.conversation += tokens;
  }
  return result;
}

declare global {
  var __piContextBreakdownCache: Map<string, ContextBreakdown> | undefined;
}

const CACHE_LIMIT = 50;

/**
 * Breakdown of a session file's current leaf. Keyed by path, mtime and size, so an
 * unchanged file costs one stat; opening the file dominates the uncached cost.
 */
export function computeFileContextBreakdown(filePath: string): ContextBreakdown {
  const stat = statSync(filePath);
  const key = `${filePath}\0${stat.mtimeMs}\0${stat.size}`;
  const cache = (globalThis.__piContextBreakdownCache ??= new Map());
  const cached = cache.get(key);
  if (cached) {
    // Refresh recency so the Map's insertion order works as an LRU.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const sm = SessionManager.open(filePath);
  const breakdown = computeContextBreakdown(buildSessionContext(sm.getEntries(), sm.getLeafId()).messages);
  cache.set(key, breakdown);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return breakdown;
}
