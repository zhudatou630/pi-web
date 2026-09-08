// Run: npm run bench:chat
// Measures deterministic chat hot paths without starting Next.js or touching user sessions.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  jsx: { runtime: "automatic" },
});

const [
  { MarkdownBody },
  { MessageView },
  { I18nProvider },
  { INITIAL_STREAMING_STATE, streamReducer },
  { mergeSessionStats },
] = await Promise.all([
  jiti.import("../components/MarkdownBody.tsx"),
  jiti.import("../components/MessageView.tsx"),
  jiti.import("../hooks/useI18n.tsx"),
  jiti.import("./streaming-message.ts"),
  jiti.import("./session-stats.ts"),
]);

const TARGET_MARKDOWN_CHARS = 50 * 1024;
const STREAM_CHUNK_CHARS = 16;
const STREAM_RENDER_STEP_CHARS = 1024;
const TRIALS = 3;

const section = [
  "## Streaming section",
  "",
  "This paragraph includes **bold text**, `inline code`, a [link](https://example.com), and CJK 文本。",
  "",
  "| name | value |",
  "| --- | ---: |",
  "| alpha | 42 |",
  "| beta | 108 |",
  "",
  "```ts",
  "const value = items.map((item) => item.id).join(\",\");",
  "```",
  "",
  "Inline math $a^2 + b^2 = c^2$.",
  "",
].join("\n");

const markdown = section.repeat(Math.ceil(TARGET_MARKDOWN_CHARS / section.length)).slice(0, TARGET_MARKDOWN_CHARS);

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function measure(label, run, trials = TRIALS) {
  const samples = [];
  for (let trial = 0; trial < trials; trial++) {
    globalThis.gc?.();
    const startedAt = performance.now();
    run();
    samples.push(performance.now() - startedAt);
  }
  return {
    scenario: label,
    medianMs: Number(median(samples).toFixed(1)),
    samplesMs: samples.map((sample) => sample.toFixed(1)).join(", "),
  };
}

function renderWithI18n(child) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, child));
}

function renderMarkdown(value, isStreaming = false) {
  return renderWithI18n(React.createElement(MarkdownBody, { isStreaming }, value));
}

function reduceStream(tabCount = 1) {
  for (let tab = 0; tab < tabCount; tab++) {
    let state = streamReducer(INITIAL_STREAMING_STATE, {
      type: "snapshot",
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    });
    for (let offset = 0; offset < markdown.length; offset += STREAM_CHUNK_CHARS) {
      state = streamReducer(state, {
        type: "delta",
        event: {
          type: "text_delta",
          contentIndex: 0,
          delta: markdown.slice(offset, offset + STREAM_CHUNK_CHARS),
        },
      });
    }
    assert.equal(state.streamingMessage?.content[0]?.text, markdown);
  }
}

function renderCumulativeMarkdown() {
  let outputLength = 0;
  for (let end = STREAM_RENDER_STEP_CHARS; end <= markdown.length; end += STREAM_RENDER_STEP_CHARS) {
    outputLength += renderMarkdown(markdown.slice(0, end), true).length;
  }
  assert.ok(outputLength > markdown.length);
}

function makeMessages(count) {
  return Array.from({ length: count }, (_, index) => index % 2 === 0
    ? { role: "user", content: `Question ${index}` }
    : {
        role: "assistant",
        content: [{ type: "text", text: `Answer ${index}\n\n${section}` }],
        timestamp: index + 1,
        usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 0, cost: { total: 0.001 } },
      });
}

const visibleTranscript = makeMessages(100).map((message, index) => React.createElement(MessageView, {
  key: index,
  message,
  isTurnEnd: message.role === "assistant",
}));

function renderTranscripts(count) {
  const transcripts = Array.from({ length: count }, (_, index) => React.createElement(
    "div",
    { key: index, hidden: index > 0 },
    visibleTranscript,
  ));
  const html = renderWithI18n(React.createElement(React.Fragment, null, transcripts));
  assert.ok(html.length > markdown.length);
}

const messages1k = makeMessages(1000);
const messages5k = makeMessages(5000);
const rows = [
  measure("stream reducer, 50 KB / 16-char deltas", () => reduceStream()),
  measure("stream reducer, 10 tabs", () => reduceStream(10)),
  measure("Markdown final render, 50 KB", () => renderMarkdown(markdown)),
  measure("Markdown cumulative renders, 1 KB steps", renderCumulativeMarkdown),
  measure("visible transcript, 50 turns", () => renderTranscripts(1)),
  measure("10 mounted transcripts, 50 turns each", () => renderTranscripts(10)),
  measure("session stats, 1,000 messages", () => mergeSessionStats(undefined, [], messages1k)),
  measure("session stats, 5,000 messages", () => mergeSessionStats(undefined, [], messages5k)),
];

console.log(`Node ${process.version}; ${TARGET_MARKDOWN_CHARS / 1024} KB markdown; ${TRIALS} trials.`);
console.log("Server-render timings are comparative CPU baselines, not browser paint or FPS measurements.");
console.table(rows);