import { getCurrentSystemMessage, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECTION = "project_context";
const OPEN = `<${SECTION}>\n`;
const CLOSE = `\n</${SECTION}>`;

/**
 * A session keeps the context files (AGENTS.md…) it started with: a later edit on disk takes
 * effect in new sessions only. Without this, every new runtime (fork, idle reload, restart)
 * appends a section patch, which rewrites the prompt prefix and drops a still-warm cache, even
 * when the session made the edit itself and already has it in its history.
 */
export function freezeProjectContext(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    const system = ctx.sessionManager.getBranch().flatMap((entry) =>
      entry.type === "message" && entry.message.role === "system" ? [entry.message as Message] : []);
    const sections = getCurrentSystemMessage(system)?.sections;
    if (!sections) return; // new session: it takes the files on disk
    const recorded = sections[SECTION];
    const options = event.systemPromptOptions;
    if (recorded == null) options.contextFiles = [];
    else if (recorded.startsWith(OPEN) && recorded.endsWith(CLOSE)) {
      options.sections[SECTION] = recorded.slice(OPEN.length, -CLOSE.length);
    }
  });
}
