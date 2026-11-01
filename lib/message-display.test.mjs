import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./message-display.ts");
}

function assistant(content) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  };
}

test("thinking pieces preserve all original characters, blank lines and CRLF", async () => {
  const { splitThinkingPieces, THINKING_PIECE_CHARS: size } = await loadSubject();
  for (const text of ["", "short\ntext", "x".repeat(size), `${"x".repeat(size)}\n`,
    `${"a".repeat(size)}\n\n\r\n${"b".repeat(size)}\r\nend`,
    "line\r\n\r\n".repeat(10_000), "一段思考💡\n".repeat(10_000), "x".repeat(100_000)]) {
    const pieces = splitThinkingPieces(text);
    assert.equal(pieces.join(""), text);
    assert.ok(pieces.every((piece) => piece.length <= 2 * size));
    assert.ok(pieces.slice(0, -1).every((piece) => piece.length >= size - 1));
  }
});

test("thinking pieces prefer the first newline past 8K and hard cut at 16K", async () => {
  const { splitThinkingPieces, THINKING_PIECE_CHARS: size } = await loadSubject();
  const line = "x".repeat(size + 7) + "\n";
  assert.deepEqual(splitThinkingPieces(line + "rest"), [line, "rest"]);
  const hard = "x".repeat(2 * size);
  assert.deepEqual(splitThinkingPieces(hard + "rest"), [hard, "rest"]);
  assert.deepEqual(splitThinkingPieces(hard + "\nrest"), [hard, "\nrest"]);
});

test("thinking hard cuts never separate surrogate pairs or CRLF", async () => {
  const { splitThinkingPieces, THINKING_PIECE_CHARS: size } = await loadSubject();
  for (const separator of ["💡", "\r\n"]) {
    const prefix = "x".repeat(2 * size - 1);
    const text = prefix + separator + "end";
    assert.deepEqual(splitThinkingPieces(text), [prefix, separator + "end"]);
  }
});

test("only the last thinking piece can change as text streams, including one code unit at a time", async () => {
  const { splitThinkingPieces, THINKING_PIECE_CHARS: size } = await loadSubject();
  const text = `${"x".repeat(2 * size - 1)}💡\r\n${"\n".repeat(size)}\n${"中".repeat(size)}\n${"a".repeat(3 * size)}`;
  for (const step of [1, 127, 12_000]) {
    let previous = [""];
    for (let end = 0; end < text.length + step; end += step) {
      const prefix = text.slice(0, end);
      const pieces = splitThinkingPieces(prefix);
      assert.equal(pieces.join(""), prefix);
      assert.deepEqual(pieces.slice(0, previous.length - 1), previous.slice(0, -1));
      previous = pieces;
    }
  }
});

test("bounds thinking previews to the first nonblank line without splitting Unicode characters", async () => {
  const { getThinkingPreview } = await loadSubject();
  assert.equal(getThinkingPreview(" \r\n **First line** \r\nSecond line"), "**First line**");
  assert.equal(getThinkingPreview("First\rSecond"), "First");
  assert.equal(getThinkingPreview(" \n\t"), "");
  assert.equal(getThinkingPreview("\u{1F4A1}".repeat(300)), "\u{1F4A1}".repeat(240));
});

test("splits trailing final answer blocks from process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
    { type: "image", source: { type: "url", url: "https://example.com/final.png" } },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text", "image"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "toolCall"]);
});

test("keeps ask_user and its preceding text in the answer, including during streaming", async () => {
  const { partitionAssistantMessage, hasTrailingFinalAnswer } = await loadSubject();
  const text = { type: "text", text: "Please clarify." };
  const question = { type: "toolCall", toolCallId: "q", toolName: "ask_user", input: {} };
  const bash = { type: "toolCall", toolCallId: "b", toolName: "bash", input: { command: "pwd" } };
  for (const isStreaming of [false, true]) {
    for (const prefix of [[], [bash]]) {
      const message = { role: "assistant", content: [...prefix, text, question] };
      const parts = partitionAssistantMessage(message, { isStreaming });
      assert.deepEqual(parts.answerMessage.content, [text, question]);
      assert.deepEqual(parts.processMessage?.content ?? [], prefix);
      assert.equal(hasTrailingFinalAnswer(message, { isStreaming }), true);
    }
    const parts = partitionAssistantMessage({ role: "assistant", content: [question] }, { isStreaming });
    assert.deepEqual(parts.answerMessage.content, [question]);
    assert.equal(parts.processMessage, null);
  }
});

test("keeps pre-tool text in process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "text", text: "I will inspect the repo first." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.equal(result.answerBlocks[0].text, "Final answer");
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["text", "toolCall"]);
});

test("does not expose text before a trailing tool call as final answer", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: "I need to call a tool." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks, []);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "text", "toolCall"]);
});

test("promotes pre-tool text longer than PROCESS_TEXT_PROMOTE_MIN_CHARS into the answer", async () => {
  const { PROCESS_TEXT_PROMOTE_MIN_CHARS, hasTrailingFinalAnswer, splitFinalAssistantBlocks } = await loadSubject();
  const longText = `${"A".repeat(PROCESS_TEXT_PROMOTE_MIN_CHARS)}X`;
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: longText },
    { type: "toolCall", toolCallId: "call-1", toolName: "edit", input: {} },
    { type: "text", text: "Saved." },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "toolCall"]);
  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text", "text"]);
  assert.equal(result.answerBlocks[0].text, longText);
  assert.equal(result.answerBlocks[1].text, "Saved.");
  assert.equal(hasTrailingFinalAnswer(message), true);
});

test("does not treat promoted pre-tool text as a trailing final answer", async () => {
  const { PROCESS_TEXT_PROMOTE_MIN_CHARS, hasTrailingFinalAnswer, splitFinalAssistantBlocks } = await loadSubject();
  const longText = `${"A".repeat(PROCESS_TEXT_PROMOTE_MIN_CHARS)}X`;
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: longText },
    { type: "toolCall", toolCallId: "call-1", toolName: "edit", input: {} },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.equal(result.answerBlocks[0].text, longText);
  assert.equal(hasTrailingFinalAnswer(message), false);
});

test("keeps recovered provider errors on the process side", async () => {
  const { PROCESS_TEXT_PROMOTE_MIN_CHARS, partitionAssistantMessage } = await loadSubject();
  const longText = `${"A".repeat(PROCESS_TEXT_PROMOTE_MIN_CHARS)}X`;

  const errorOnly = partitionAssistantMessage({
    ...assistant([]),
    stopReason: "error",
    errorMessage: "server_error: Our servers are currently overloaded.",
  });
  assert.equal(errorOnly.answerMessage, null);
  assert.equal(errorOnly.processMessage?.errorMessage, "server_error: Our servers are currently overloaded.");
  assert.equal(errorOnly.processMessage?.stopReason, "error");

  const promoted = partitionAssistantMessage({
    ...assistant([
      { type: "text", text: longText },
      { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    ]),
    stopReason: "error",
    errorMessage: "OpenAI API error (502)",
  });
  assert.equal(promoted.answerMessage?.errorMessage, undefined);
  assert.equal(promoted.answerMessage?.content[0].text, longText);
  assert.equal(promoted.processMessage?.errorMessage, "OpenAI API error (502)");

  const trailing = partitionAssistantMessage({
    ...assistant([
      { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
      { type: "text", text: "Done." },
    ]),
    stopReason: "error",
    errorMessage: "Codex error",
  });
  assert.equal(trailing.answerMessage?.errorMessage, "Codex error");
  assert.equal(trailing.processMessage?.errorMessage, undefined);
  assert.equal(trailing.processMessage?.stopReason, "stop");
});

test("keeps pre-tool text of exactly PROCESS_TEXT_PROMOTE_MIN_CHARS in process blocks", async () => {
  const { PROCESS_TEXT_PROMOTE_MIN_CHARS, splitFinalAssistantBlocks } = await loadSubject();
  const edgeText = "B".repeat(PROCESS_TEXT_PROMOTE_MIN_CHARS);
  const message = assistant([
    { type: "text", text: edgeText },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks, []);
  assert.equal(result.processBlocks[0].text, edgeText);
});

test("drops empty thinking blocks after completion", async () => {
  const { getDisplayableAssistantBlocks, splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["text"],
  );

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });
  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks, []);
});

test("drops empty text blocks after completion and does not expose trailing empty text as final answer", async () => {
  const { getDisplayableAssistantBlocks, splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["toolCall"],
  );

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });
  assert.deepEqual(result.answerBlocks, []);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["toolCall"]);
});

test("keeps empty thinking while streaming", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Partial answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: true });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking"]);
});

test("drops whitespace text while streaming, like the settled message", async () => {
  const { partitionAssistantMessage } = await loadSubject();
  // Gemini ends tool-call turns with an empty text part; a streamed-only row bounced the scroll.
  for (const text of ["", "\n "]) {
    const message = assistant([
      { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
      { type: "text", text },
    ]);
    const live = partitionAssistantMessage(message, { isStreaming: true });
    assert.deepEqual(live.processMessage?.content.map((block) => block.type), ["toolCall"]);
    assert.equal(live.answerMessage, null);
  }
});

test("keeps deferred historical thinking placeholders", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "", deferred: true },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["thinking", "text"],
  );
});

test("returns completed provider errors even when the message has no content", async () => {
  const { getAssistantErrorMessage } = await loadSubject();
  const message = {
    ...assistant([]),
    stopReason: "error",
    errorMessage: "OpenAI API error (403): request forbidden",
  };

  assert.equal(
    getAssistantErrorMessage(message),
    "OpenAI API error (403): request forbidden",
  );
  assert.equal(getAssistantErrorMessage(message, { isStreaming: true }), null);
});

test("falls back when a provider error has no message", async () => {
  const { getAssistantErrorMessage } = await loadSubject();

  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "error" }),
    "Unknown provider error",
  );
  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "stop" }),
    null,
  );
});

test("flags a response cut off by the output limit, and only once it settles", async () => {
  const { isAssistantTruncated, partitionAssistantMessage } = await loadSubject();
  const truncated = { ...assistant([{ type: "text", text: "partial answer" }]), stopReason: "length" };

  assert.equal(isAssistantTruncated(truncated), true);
  // Still streaming: the stop reason is not final yet, so no notice.
  assert.equal(isAssistantTruncated(truncated, { isStreaming: true }), false);
  assert.equal(isAssistantTruncated({ ...assistant([]), stopReason: "stop" }), false);
  assert.equal(isAssistantTruncated({ ...assistant([]), stopReason: "error" }), false);

  // A truncated turn still exposes its partial text as the answer, so the
  // notice renders next to real content instead of replacing it.
  const parts = partitionAssistantMessage(truncated);
  assert.equal(parts.answerMessage?.content[0].text, "partial answer");
});

test("treats compaction summaries as turn anchors", async () => {
  const { isMessageGroupAnchor, isMessageGroupBoundary, isSubagentNotificationMessage } = await loadSubject();

  assert.equal(isMessageGroupAnchor({ role: "user", content: "prompt" }), true);
  assert.equal(isMessageGroupAnchor({
    role: "custom",
    customType: "compaction",
    content: "summary",
    display: true,
  }), true);
  const notification = {
    role: "custom",
    customType: "pi-web:subagent-notification",
    content: "results",
    display: true,
  };
  assert.equal(isSubagentNotificationMessage(notification), true);
  assert.equal(isMessageGroupAnchor(notification), false);
  assert.equal(isMessageGroupBoundary(notification), true);
  assert.equal(isMessageGroupBoundary({ role: "custom", customType: "extension" }), false);
  assert.equal(isMessageGroupAnchor(assistant([])), false);
});

test("hides custom messages without display and never lets them start a turn (#1043)", async () => {
  const { isHiddenCustomMessage, isMessageGroupAnchor, isMessageGroupBoundary } = await loadSubject();
  const custom = (customType, display) => ({ role: "custom", customType, content: "payload", display });

  assert.equal(isHiddenCustomMessage(custom("extension_debug", false)), true);
  assert.equal(isHiddenCustomMessage({ role: "custom", customType: "legacy", content: "" }), true);
  assert.equal(isHiddenCustomMessage(custom("pi-image-result", true)), false);
  assert.equal(isHiddenCustomMessage({ role: "user", content: "prompt" }), false);
  assert.equal(isMessageGroupBoundary(custom("pi-web:subagent-notification", false)), false);
  assert.equal(isMessageGroupBoundary(custom("subagent-notification", false)), false);
  assert.equal(isMessageGroupAnchor(custom("compaction", false)), false);
  // @tintinweb/pi-subagents' bare completion notice starts a turn like pi-web's own.
  assert.equal(isMessageGroupBoundary(custom("subagent-notification", true)), true);
  assert.equal(isMessageGroupAnchor(custom("subagent-notification", true)), false);
});

test("an abort recorded as a provider error is told apart from a real failure", async () => {
  const { isAbortedAssistantError } = await loadSubject();
  const failed = (errorMessage) => ({ ...assistant([]), stopReason: "error", errorMessage });
  assert.equal(isAbortedAssistantError(failed("This operation was aborted")), true);
  assert.equal(isAbortedAssistantError(failed("Request was aborted.")), true);
  assert.equal(isAbortedAssistantError(failed("The operation was aborted due to timeout")), false);
  assert.equal(isAbortedAssistantError(failed("429 rate limit exceeded")), false);
  assert.equal(isAbortedAssistantError({ ...assistant([]), stopReason: "aborted", errorMessage: "This operation was aborted" }), false);
});
