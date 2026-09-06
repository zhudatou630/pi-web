/**
 * Fast and robust token estimator for streaming text, thinking, and tool calls.
 * CJK characters count as ~1 token each (reflecting modern tokenizers like GLM,
 * DeepSeek, o200k, Claude, Gemini); other characters average ~4 chars per token.
 */
const CJK_PATTERN = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\uac00-\ud7af]/u;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) cjk++;
    else rest++;
  }
  return cjk + rest / 4;
}

export function estimateMessageTokens(message: { content?: unknown[] } | null | undefined): number {
  if (!message?.content || !Array.isArray(message.content)) return 0;
  let total = 0;
  for (const item of message.content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      total += estimateTokens(block.text);
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      total += estimateTokens(block.thinking);
    } else if (block.type === "toolCall") {
      const raw = typeof block.rawInput === "string" ? block.rawInput : JSON.stringify(block.input ?? {});
      total += estimateTokens(raw);
    }
  }
  return total;
}
