import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Design: docs/routines.md ("Asking the user").

export const ASK_USER_TOOL_NAME = "ask_user";

export interface AskUserParams {
  question: string;
  options: string[];
  multi_select?: boolean;
}

/** Trimmed and checked; throws a message the model can act on. */
export function parseAskUserParams(params: AskUserParams): AskUserParams {
  const question = params.question?.trim() ?? "";
  if (!question || question.length > 300) throw new Error("question must be 1-300 characters");
  const options = (params.options ?? []).map((option) => String(option).trim()).filter(Boolean);
  if (options.length < 2 || options.length > 6) throw new Error("give 2 to 6 non-empty options");
  if (options.some((option) => option.length > 80)) throw new Error("options must be short labels (80 characters at most)");
  // A clicked answer goes through the composer's send path, where "!" runs a shell command and "/" a slash command.
  if (options.some((option) => /^[!/]/.test(option))) throw new Error("an option must not start with ! or /");
  if (new Set(options).size !== options.length) throw new Error("options must be different");
  // The answer comes back as the chosen labels, one per line.
  if (options.some((option) => option.includes("\n"))) throw new Error("an option must be one line");
  return { question, options, multi_select: params.multi_select === true };
}

/**
 * `ask_user`: a question card with options. It does not wait for the answer: the call ends
 * the turn (`terminate`) and the answer arrives as the user's next message, clicked on the
 * card or typed. Nothing hangs in an unattended run or after the runtime is disposed.
 *
 * Part of the routines tools, not a general tool: no prompt hint of its own, so chats that do
 * not schedule anything see no change. `create_routine`'s description points to it.
 */
export function registerAskUserTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: ASK_USER_TOOL_NAME,
    label: "Ask user",
    exposure: "deferred",
    description: "Ask the user one question with 2-6 short options, shown as a card they click or answer by typing. It ends your turn: put context in your text before it and call it last and alone. The answer is the user's next message (chosen options, one per line). Ask only what changes your next step and you cannot find out yourself.",
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Array(Type.String()),
      multi_select: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      let question: AskUserParams;
      try {
        question = parseAskUserParams(params as AskUserParams);
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Not asked: ${error instanceof Error ? error.message : String(error)}` }],
          details: undefined,
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: "Shown to the user. Stop here: their answer arrives as the next user message." }],
        details: question,
        terminate: true,
      };
    },
  });
}
