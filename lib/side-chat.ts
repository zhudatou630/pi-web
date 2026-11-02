import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitQuotedPrompt } from "./quoted-selection";
import { PRESET_READ_ONLY } from "./tool-presets";

/**
 * A side chat is a fork whose copy ends on one hidden custom message of this type.
 * It marks the session as a side chat, tells the model the main agent goes on
 * without it, and places the chat's divider. Nothing else about the copy changes:
 * model, thinking level, system prompt and declared tools stay the parent's, so the
 * first request reuses the parent's prompt cache (a removed tool or a changed
 * thinking level rewrites the prefix on providers without mid-conversation updates).
 */
export const SIDE_CHAT_TYPE = "pi-web:side";

/** The only tools that run in a side chat; the rest stay declared and are refused when called. */
export const SIDE_CHAT_TOOLS: readonly string[] = PRESET_READ_ONLY;

export const SIDE_CHAT_BOUNDARY = `<side-chat>
The user opened a side chat at this point of the conversation. You are a separate instance answering it. The main agent was not interrupted: it keeps working on its own, the latest turns above may still be unfinished, and nothing said here reaches it. Do not continue or resume the main task, and do not describe yourself as interrupted.
Only read-only tools run here: those of ${SIDE_CHAT_TOOLS.join(", ")} that you have. Any other tool call is refused. Answer from the conversation so far, and use those tools only when the answer needs a file's current content.
</side-chat>`;

export interface SideChatDetails {
  /** The main session's id; a side chat of a side chat keeps it, since it is the cache key both send. */
  parentSessionId: string;
}

type EntryLike = { type: string; customType?: string; details?: unknown };

/**
 * The main session's id when these entries hold a side-chat marker (the last one wins).
 * Callers pass the whole file, not a branch: going back before the marker must not lift the guard.
 */
export function sideChatParentId(entries: readonly EntryLike[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom_message" || entry.customType !== SIDE_CHAT_TYPE) continue;
    const parentSessionId = (entry.details as Partial<SideChatDetails> | undefined)?.parentSessionId;
    return typeof parentSessionId === "string" && parentSessionId ? parentSessionId : undefined;
  }
  return undefined;
}

/** Side chats run read tools only. Nested codemode calls pass this hook too. */
export function sideChatToolGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    if (SIDE_CHAT_TOOLS.includes(event.toolName)) return;
    if (!sideChatParentId(ctx.sessionManager.getEntries())) return;
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
