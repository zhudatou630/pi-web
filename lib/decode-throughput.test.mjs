import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  applyStoredDecodeThroughput,
  armDecodeClock,
  decodeStatsKey,
  deltaIndicatesGeneratedToken,
  formatDecodeDurationParts,
  formatTokensPerSecond,
  messageHasGeneratedToken,
  observeGeneratedToken,
  settleDecodeThroughput,
  shouldDisplayTtft,
} = await jiti.import("./decode-throughput.ts");

test("first token is the first non-empty thinking, text, or tool call", () => {
  assert.equal(messageHasGeneratedToken({ content: [] }), false);
  assert.equal(messageHasGeneratedToken({ content: [{ type: "text", text: "" }] }), false);
  assert.equal(messageHasGeneratedToken({ content: [{ type: "thinking", thinking: "a" }] }), true);
  assert.equal(messageHasGeneratedToken({ content: [{ type: "text", text: "Hi" }] }), true);
  assert.equal(messageHasGeneratedToken({ content: [{ type: "toolCall", toolName: "read", input: {} }] }), true);
  assert.equal(deltaIndicatesGeneratedToken({ type: "thinking_start", contentIndex: 0 }), false);
  assert.equal(deltaIndicatesGeneratedToken({ type: "thinking_delta", contentIndex: 0, delta: "" }), false);
  assert.equal(deltaIndicatesGeneratedToken({ type: "thinking_delta", contentIndex: 0, delta: "Plan" }), true);
  assert.equal(deltaIndicatesGeneratedToken({ type: "text_delta", contentIndex: 0, delta: "H" }), true);
  assert.equal(deltaIndicatesGeneratedToken({ type: "toolcall_start", contentIndex: 0, toolName: "bash" }), true);
});

test("tok/s is output tokens over first-token to completion, TTFT excluded", () => {
  const stats = settleDecodeThroughput({
    requestStartAt: 1000,
    firstTokenAt: 3000,
    completedAt: 5000,
    outputTokens: 200,
  });
  assert.deepEqual(stats, { ttftMs: 2000, tokensPerSecond: 100 });
});

test("does not invent tok/s without provider output tokens", () => {
  const stats = settleDecodeThroughput({
    requestStartAt: 0,
    firstTokenAt: 1500,
    completedAt: 2500,
    outputTokens: null,
  });
  assert.deepEqual(stats, { ttftMs: 1500 });
  assert.equal(stats.tokensPerSecond, undefined);
});

test("does not settle when the first token was never seen", () => {
  assert.equal(settleDecodeThroughput({
    requestStartAt: 0,
    firstTokenAt: null,
    completedAt: 5000,
    outputTokens: 999,
  }), null);
});

test("zero decode window omits tok/s", () => {
  const stats = settleDecodeThroughput({
    requestStartAt: 0,
    firstTokenAt: 1000,
    completedAt: 1000,
    outputTokens: 80,
  });
  assert.equal(stats?.tokensPerSecond, undefined);
});

test("zero output tokens omits tok/s", () => {
  const stats = settleDecodeThroughput({
    requestStartAt: 0,
    firstTokenAt: 1000,
    completedAt: 2000,
    outputTokens: 0,
  });
  assert.equal(stats?.tokensPerSecond, undefined);
  assert.equal(stats?.ttftMs, 1000);
});

test("clock keeps the first observed token time", () => {
  const clock = observeGeneratedToken(
    observeGeneratedToken(armDecodeClock(10), 25),
    40,
  );
  assert.equal(clock.requestStartAt, 10);
  assert.equal(clock.firstTokenAt, 25);
});

test("formats tok/s like DSH: integer at 10+, one decimal below", () => {
  assert.equal(formatTokensPerSecond(9.44), "9.4");
  assert.equal(formatTokensPerSecond(10.4), "10");
  assert.equal(formatTokensPerSecond(86.2), "86");
});

test("TTFT under 100ms is not worth a label", () => {
  assert.equal(shouldDisplayTtft(99), false);
  assert.equal(shouldDisplayTtft(100), true);
});

test("duration parts split at one minute", () => {
  assert.deepEqual(formatDecodeDurationParts(2400), { seconds: 2.4 });
  assert.deepEqual(formatDecodeDurationParts(90_000), { minutes: 1, seconds: 30 });
});

test("rehydrates decode stats onto file-loaded assistant messages", () => {
  const stats = { ttftMs: 1200, tokensPerSecond: 40 };
  const stored = new Map([[decodeStatsKey({ timestamp: 9, model: "m" }), stats]]);
  const messages = applyStoredDecodeThroughput([
    { role: "user", content: "hi", timestamp: 8 },
    { role: "assistant", content: [], model: "m", provider: "p", timestamp: 9 },
  ], stored);
  assert.deepEqual(messages[1].decode, stats);
});
