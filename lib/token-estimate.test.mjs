import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, estimateMessageTokens } from "./token-estimate.ts";

test("estimates English text tokens (~4 chars/token)", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("12345678"), 2);
});

test("estimates CJK characters (~1 token/char)", () => {
  assert.equal(estimateTokens("你好世界"), 4);
  assert.equal(estimateTokens("你好 world"), 2 + 6 / 4);
});

test("estimates tokens from message content with mixed blocks", () => {
  const message = {
    content: [
      { type: "thinking", thinking: "思考中..." },
      { type: "text", text: "Hello" },
      { type: "toolCall", rawInput: '{"file":"test.txt"}' },
    ],
  };
  const tokens = estimateMessageTokens(message);
  assert.ok(tokens > 0);
});
