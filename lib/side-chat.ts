import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitQuotedPrompt } from "./quoted-selection";
import { PRESET_READ_ONLY } from "./tool-presets";

/**
 * A side chat is a fork that asks aside about its parent. Two marks, both written by
 * forkSessionBranch():
 * - the header's `piWebSide` names the main session: it makes the copy a side chat
 *   (tool guard, cache key, a member of the main session's family) and is read by the
 *   session scanner from the first line, however long the chat grows;
 * - one hidden custom message of SIDE_CHAT_TYPE ends the copied history: it tells the
 *   model the main agent goes on without it, and places the chat's divider.
 * Nothing else about the copy changes: model, thinking level, system prompt and declared
 * tools stay the parent's, so the first request reuses the parent's prompt cache (a removed
 * tool or a changed thinking level rewrites the prefix on providers without
 * mid-conversation updates). The header is not part of the prompt.
 * The side chat's runtime rebuilds the prompt from disk, so a section that changed since the
 * parent started (context files are frozen by freezeProjectContext; skills are not) would
 * append a patch that rewrites the prefix the same way; sideChatToolGuard keeps such patches
 * out of the request.
 */
export const SIDE_CHAT_TYPE = "pi-web:side";

/** The only tools that run in a side chat; the rest stay declared and are refused when called. */
export const SIDE_CHAT_TOOLS: readonly string[] = PRESET_READ_ONLY;

export const SIDE_CHAT_BOUNDARY = `<side-chat>
The user opened a side chat at this point of the conversation. You are a separate instance answering it. The main agent was not interrupted: it keeps working on its own, the latest turns above may still be unfinished, and nothing said here reaches it. Do not continue or resume the main task, and do not describe yourself as interrupted.
Only read-only tools run here: those of ${SIDE_CHAT_TOOLS.join(", ")} that you have. Any other tool call is refused. Answer from the conversation so far, and use those tools only when the answer needs a file's current content.
</side-chat>`;

export const SIDE_CHAT_HEADER_KEY = "piWebSide";

export interface SideChatHeader {
  /** The main session's id; a side chat of a side chat keeps it, since it is the cache key both send. */
  parentSessionId: string;
}

/** The main session's id when a session header marks a side chat. */
export function sideChatParentId(header: unknown): string | undefined {
  const side = (header as Record<string, unknown> | null | undefined)?.[SIDE_CHAT_HEADER_KEY];
  const parentSessionId = (side as Partial<SideChatHeader> | null | undefined)?.parentSessionId;
  return typeof parentSessionId === "string" && parentSessionId ? parentSessionId : undefined;
}

/**
 * Side chats run read tools only. Nested codemode calls pass this hook too.
 * Requests keep the parent's prompt sections: system messages after the side boundary that only
 * patch sections (no tool declaration change) are left out, so the parent's cache stays usable.
 */
export function sideChatToolGuard(pi: ExtensionAPI): void {
  pi.on("context_with_system", (event, ctx) => {
    if (!sideChatParentId(ctx.sessionManager.getHeader())) return;
    const boundary = event.messages.findLastIndex((m) => m.role === "custom" && m.customType === SIDE_CHAT_TYPE);
    if (boundary < 0) return;
    return {
      messages: event.messages.filter((m, i) =>
        i < boundary || m.role !== "system" || Boolean(m.toolsAdded?.length || m.toolsRemoved?.length)),
    };
  });
  pi.on("tool_call", (event, ctx) => {
    if (SIDE_CHAT_TOOLS.includes(event.toolName)) return;
    if (!sideChatParentId(ctx.sessionManager.getHeader())) return;
    return {
      block: true,
      reason: `${event.toolName} does not run in a side chat. Only ${SIDE_CHAT_TOOLS.join(", ")} run here: answer from the conversation.`,
    };
  });
}

/** `prefix` plus the question's first words, quotes left out (a quote's text is the same for every question). */
export function getSideChatName(prompt: string, prefix: string): string {
  const { quotes, message } = splitQuotedPrompt(prompt);
  const text = (message || quotes[0]?.text || "").replace(/\s+/g, " ").trim();
  return `${prefix}${text.length > 60 ? `${text.slice(0, 59)}…` : text}`;
}
