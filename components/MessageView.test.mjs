import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  MessageView,
  ThinkingBlock,
  getToolCallInputText,
  replaceUserMessageText,
} = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { splitFinalAssistantBlocks } = await jiti.import("@/lib/message-display");
const source = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");

test("looks up tool durations only for calls in the current assistant message", () => {
  assert.match(source, /for \(const block of message\.content\)/);
  assert.match(source, /const result = toolResults\.get\(block\.toolCallId\)/);
  assert.doesNotMatch(source, /for \(const \[callId, result\] of toolResults\)/);
});

test("derives thinking and tool durations from message timestamps, not a view clock", () => {
  assert.match(source, /function elapsedSeconds/);
  assert.match(source, /elapsedSeconds\(message\.timestamp, message\.completedAt\)/);
  assert.match(source, /message\.completedAt \?\? message\.timestamp/);
  assert.doesNotMatch(source, /blockStartTimesRef/);
  assert.doesNotMatch(source, /finalDurations/);
  assert.doesNotMatch(source, /thinkingDurationFromFile/);
  assert.doesNotMatch(source, /prevTimestamp/);
});

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("renders generated image mentions as chips in user messages", () => {
  const html = renderMessage({
    role: "user",
    content: '@".pi/generated-images/old image.jpg" make the light warmer',
  }, { cwd: "/project" });
  assert.match(html, /<img/);
  assert.match(html, /make the light warmer/);
  assert.doesNotMatch(html, /@&quot;\.pi\/generated-images/);
});

test("updates a reused message when its written files change", () => {
  const props = { message: { role: "assistant", content: [] } };
  assert.equal(MessageView.compare(props, props), true);
  assert.equal(MessageView.compare(props, { ...props, writtenFiles: [{ path: "/tmp/result.txt" }] }), false);
  assert.equal(MessageView.compare(props, { ...props, isProcess: true }), false);
});

test("previews the first thinking line and reveals the full text with the saved default", () => {
  const previousWindow = globalThis.window;
  try {
    for (const expanded of [false, true]) {
      globalThis.window = { localStorage: { getItem: () => String(expanded) } };
      const html = renderToStaticMarkup(React.createElement(
        I18nProvider,
        null,
        React.createElement(ThinkingBlock, {
          block: { type: "thinking", thinking: "**Independent reasoning**\n\nDetailed second line." },
          blockIndex: 2,
          duration: 3,
        }),
      ));
      assert.match(html, new RegExp(`aria-expanded="${expanded}"`));
      assert.equal((html.match(/>[^<]*Independent reasoning[^<]*</g) ?? []).length, 1);
      assert.equal(html.includes("Detailed second line."), expanded);
      assert.match(html, /aria-label="Thinking: /);
      assert.match(html, /3s/);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("shows thinking duration from completedAt minus start, not the previous message", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    timestamp: 1_000,
    completedAt: 6_000,
    content: [{ type: "thinking", thinking: "Plan the charts" }],
  });
  assert.match(html, />5s</);
  assert.doesNotMatch(html, />0s</);
});

test("shows tool duration from the tool result minus generation end", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    timestamp: 1_000,
    completedAt: 5_000,
    content: [{ type: "toolCall", toolCallId: "bash-1", toolName: "bash", input: { command: "mkdir x" } }],
  }, {
    toolResults: new Map([
      ["bash-1", { role: "toolResult", toolCallId: "bash-1", timestamp: 8_000, content: [{ type: "text", text: "ok" }] }],
    ]),
  });
  assert.match(html, />3s</);
  assert.doesNotMatch(html, />7s</);
});

test("shows deferred thinking previews without loading the full content", () => {
  const html = renderMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: "Historical first line", deferred: true }],
  });
  assert.match(html, />Historical first line<\/span>/);
  assert.match(html, /aria-expanded="false"/);
});

test("marks only the matched text block after splitting thinking and the final answer", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "Thinking about the result" },
      { type: "text", text: "Process text" },
      { type: "toolCall", toolCallId: "read-1", toolName: "read", input: {} },
      { type: "text", text: "First answer" },
      { type: "text", text: "Matched pi-cwd-spark answer" },
    ],
  };
  const { processBlocks, answerBlocks } = splitFinalAssistantBlocks(message);
  for (const index of [2, 4, 5]) {
    const searchBlock = message.content[index];
    for (const content of [processBlocks, answerBlocks]) {
      const html = renderMessage({ ...message, content }, { searchBlock });
      assert.equal((html.match(/data-search-target="true"/g) ?? []).length, content.includes(searchBlock) ? 1 : 0);
      if (content.includes(searchBlock)) {
        assert.match(html, new RegExp(`data-search-target="true">(?:(?!data-message-text)[\\s\\S])*${searchBlock.text}`));
      }
    }
  }
});

test("keeps streamed tool input out of collapsed markup", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-write-1",
    toolName: "write",
    input: {},
    rawInput: '{"path":"/tmp/file","content":"secret-stream-fragment',
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { isStreaming: true });

  assert.match(html, /write/);
  assert.match(html, /Generating parameters/);
  assert.doesNotMatch(html, /secret-stream-fragment/);
  assert.equal(getToolCallInputText(block), block.rawInput);
});

test("omits model labels, usage and copy footers from assistant replies", () => {
  for (const isStreaming of [false, true]) {
    for (const content of [
      [{ type: "text", text: "Visible reply" }],
      [{ type: "toolCall", toolCallId: "read-usage", toolName: "read", input: { path: "/tmp/example" } }],
    ]) {
      const html = renderMessage({
        role: "assistant",
        provider: "openai",
        model: "test-model",
        content,
        usage: { input: 246, output: 267, cacheRead: 61568, cacheWrite: 10, cost: { total: 0.0774 } },
      }, { isStreaming });
      assert.doesNotMatch(html, /test-model|title="Copy message"/);
      assert.match(html, content[0].type === "text" ? /Visible reply/ : /read/);
      assert.doesNotMatch(html, /246 in|267 out|cache R|cache W|\$0\.0774|Estimated token count| t\/s/);
      assert.match(html, /data-message-role="assistant"[^>]*style="margin-bottom:8px"/);
    }
  }
});

test("restores copy and time only on a completed final answer", () => {
  const timestamp = Date.now();
  const message = {
    role: "assistant",
    provider: "openai",
    model: "hidden-model",
    content: [{ type: "text", text: "Final answer" }],
    timestamp,
    usage: { input: 246, output: 267, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0774 } },
  };
  const html = renderMessage(message, { isTurnEnd: true, modelName: "GPT-6 Astra" });
  assert.match(html, /data-answer-model[^>]*>GPT-6 Astra<\/div>/);
  assert.equal((html.match(/GPT-6 Astra/g) ?? []).length, 1);
  const fallbackHtml = renderMessage(message, { isTurnEnd: true });
  assert.match(fallbackHtml, /data-answer-model[^>]*>hidden-model<\/div>/);
  assert.match(html, /margin-bottom:16px/);
  assert.match(html, /data-answer-footer[^>]*justify-content:flex-end/);
  assert.doesNotMatch(html.slice(html.indexOf("data-answer-footer")), /margin-left:auto/);
  assert.match(html, /title="Copy message"/);
  assert.ok(html.includes(new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
  assert.doesNotMatch(html, /opacity:0|hidden-model|246 in|267 out|\$0\.0774/);

  for (const props of [{ isTurnEnd: false }, { isTurnEnd: true, isStreaming: true }]) {
    const processHtml = renderMessage(message, { ...props, modelName: "GPT-6 Astra" });
    assert.doesNotMatch(processHtml, /data-answer-model|GPT-6 Astra|hidden-model|data-answer-footer|title="Copy message"|font-size:10px/);
  }
});

test("renders subagents as standard tool calls with only an extra session button", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-agent-1",
    toolName: "Agent",
    input: {
      subagent_type: "Explore",
      prompt: "Find the parser",
      description: "Find parser",
    },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "Parser is in lib/parser.ts" }],
    details: {
      kind: "pi-web-subagent",
      sessionId: "child-session",
      profile: "Explore",
      description: "Find parser",
      status: "completed",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, {
    toolResults: new Map([[block.toolCallId, result]]),
    onOpenSession() {},
  });

  assert.match(html, /border:1px solid var\(--border\)/);
  assert.match(html, />Agent</);
  assert.match(html, />Explore</);
  assert.match(html, /aria-label="Open sub-agent session"/);
  assert.doesNotMatch(html, />completed</);
  assert.doesNotMatch(html, />Find parser</);

  const ordinaryHtml = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ ...block, toolCallId: "call-extension-1", toolName: "extension_tool" }],
  }, {
    toolResults: new Map(),
    onOpenSession() {},
  });
  assert.doesNotMatch(ordinaryHtml, /Open sub-agent session/);
});

test("keeps pending and successful tools neutral while retaining error emphasis", () => {
  const block = {
    type: "toolCall", toolCallId: "read-style", toolName: "read",
    input: { path: "src/example.ts" },
  };
  for (const state of ["pending", "generating", "success", "error"]) {
    const result = state === "success" || state === "error" ? {
      role: "toolResult", toolCallId: block.toolCallId,
      isError: state === "error", content: [{ type: "text", text: "tool-result-payload" }],
    } : undefined;
    const html = renderMessage({
      role: "assistant",
      content: [{ ...block, ...(state === "generating" ? { rawInput: '{"path":' } : {}) }],
    }, {
      isStreaming: state === "generating",
      toolResults: new Map(result ? [[block.toolCallId, result]] : []),
    });
    if (state === "error") {
      assert.match(html, /border:1px solid rgba\(248,113,113,0\.45\)/);
      assert.match(html, /color:#f87171/);
    } else {
      assert.match(html, /border:1px solid var\(--border\);background:var\(--bg-subtle\)/);
      assert.doesNotMatch(html, /34,197,94|#16a34a|#f87171/);
    }
    const preview = state === "generating" ? "Generating parameters" : "src/example.ts";
    assert.ok(html.includes(preview));
    assert.match(html, /color:var\(--text-muted\);font-family:var\(--font-mono\);font-size:11px;overflow:hidden/);
    assert.doesNotMatch(html, /tool-result-payload/); // Still collapsed by default.
  }
});

const COMPLETE_SKILL_EXPANSION = `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Review the supplied files.
</skill>

src/main.ts`;

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders a collapsed step-card for provider error when in process mode", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "Internal error during token generation\nDetailed stack trace here",
  }, { isProcess: true });

  assert.match(html, /data-step-card=""/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="[^"]+"/);
  assert.match(html, />Model error<\/span>/);
  assert.match(html, /Internal error during token generation/);
  assert.doesNotMatch(html, /Detailed stack trace here/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("marks persisted assistant messages with their source entry", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Select this response" }],
  }, { entryId: "assistant-entry" });

  assert.match(html, /data-message-role="assistant"/);
  assert.match(html, /data-entry-id="assistant-entry"/);
});

test("renders a complete SDK skill expansion as a compact command", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION,
  });

  assert.match(html, /\/skill:review/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Review the supplied files/);
});

test("does not collapse incomplete skill-looking user text", () => {
  const html = renderMessage({
    role: "user",
    content: '<skill name="review" location="/skills/review/SKILL.md">\nordinary user text',
  });

  assert.match(html, /ordinary user text/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("keeps attached images when restoring a compact command for editing", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const restored = replaceUserMessageText({
    role: "user",
    content: [{ type: "text", text: COMPLETE_SKILL_EXPANSION }, image],
  }, "/skill:review src/main.ts");

  assert.deepEqual(restored.content, [
    { type: "text", text: "/skill:review src/main.ts" },
    image,
  ]);
});

test("renders user-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("renders custom-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "custom",
    customType: "extension",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("renders subagent notifications as a compact collapsed step", () => {
  const html = renderMessage({
    role: "custom",
    customType: "pi-web:subagent-notification",
    content: "## First result\nFull result body",
    display: true,
    details: {
      kind: "pi-web-subagent-wave",
      sessionIds: ["one", "two", "three"],
    },
  });

  assert.match(html, /data-step-card=""/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /3 sub-agents finished/);
  assert.doesNotMatch(html, /markdown-subagent-notification/);
  assert.doesNotMatch(html, /pi-web:subagent-notification|First result|Full result body|Show details/);
});

test("renders assistant image answers instead of leaving a blank final answer", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } };
  const mixed = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "vision",
    content: [{ type: "text", text: "Here is the screenshot" }, image],
  });
  assert.match(mixed, /Here is the screenshot/);
  assert.match(mixed, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(mixed, /<img[^>]+src="data:image\/png;base64,YWJj"/);

  const onlyImage = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "vision",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
  });
  assert.match(onlyImage, /<img[^>]+src="data:image\/png;base64,YWJj"/);
  assert.doesNotMatch(onlyImage, /data-message-text/);
});
