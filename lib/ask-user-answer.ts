import type { AgentMessage, ToolResultMessage } from "./types";

export function formatAskUserAnswer(options: readonly string[]): string {
  return options.join("\n");
}

export function matchAskUserOptions(options: readonly string[], answer: string): string[] {
  const lines = new Set(answer.split(/\r?\n/).map((line) => line.trim()));
  return options.filter((option) => lines.has(option));
}

function questionOptions(block: { input?: Record<string, unknown> }, result: ToolResultMessage | undefined): string[] {
  const source = result?.details && typeof result.details === "object" ? result.details as Record<string, unknown> : block.input;
  return Array.isArray(source?.options) ? source.options.filter((option): option is string => typeof option === "string") : [];
}

/**
 * Per ask_user call, the answer (the first user message after it; an empty message still
 * answers, only null means unanswered), the question that can still be answered, and the
 * answer messages the card already shows: sent by clicking it (only chosen labels, one per
 * line, text only), so their bubble is hidden like Grok's. Typed answers keep their bubble.
 */
export function findAskUserAnswers(
  messages: readonly AgentMessage[],
  toolResults: ReadonlyMap<string, ToolResultMessage>,
  isIdle: boolean,
): { answers: ReadonlyMap<string, string | null>; activeQuestionId: string | null; cardAnswerIndexes: ReadonlySet<number> } {
  const answers = new Map<string, string | null>();
  const cardAnswerIndexes = new Set<number>();
  let nextAnswer: string | null = null;
  let nextAnswerIdx = -1;
  let nextAnswerTextOnly = false;
  let latestQuestionId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") {
      nextAnswer = typeof message.content === "string" ? message.content : message.content
        .filter((block) => block.type === "text").map((block) => block.text).join("\n");
      nextAnswerIdx = i;
      nextAnswerTextOnly = typeof message.content === "string" || message.content.every((block) => block.type === "text");
    } else if (message.role === "assistant") {
      for (let j = message.content.length - 1; j >= 0; j--) {
        const block = message.content[j];
        if (block.type !== "toolCall" || block.toolName !== "ask_user") continue;
        latestQuestionId ??= block.toolCallId;
        answers.set(block.toolCallId, nextAnswer);
        const result = toolResults.get(block.toolCallId);
        // A failed call renders as a plain tool error, with no card to show the answer instead.
        if (nextAnswer === null || !nextAnswerTextOnly || !result || result.isError) continue;
        const chosen = matchAskUserOptions(questionOptions(block, result), nextAnswer);
        if (chosen.length > 0 && formatAskUserAnswer(chosen) === nextAnswer.trim()) cardAnswerIndexes.add(nextAnswerIdx);
      }
    }
  }
  const result = latestQuestionId ? toolResults.get(latestQuestionId) : undefined;
  const activeQuestionId = isIdle && latestQuestionId && answers.get(latestQuestionId) === null && result && !result.isError
    ? latestQuestionId : null;
  return { answers, activeQuestionId, cardAnswerIndexes };
}
