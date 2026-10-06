import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const {
  buildSessionMarkdown,
  rebaseHeadings,
  sanitizeExportFileName,
  MARKDOWN_IMAGE_PLACEHOLDER,
} = await createJiti(import.meta.url).import("./session-export-markdown.ts");

const exportedAt = new Date("2026-09-07T04:12:00.000Z");

function entry(id, parentId, type, extra = {}) {
  return { id, parentId, type, timestamp: "2026-09-07T00:00:00Z", ...extra };
}

function user(id, parentId, content) {
  return entry(id, parentId, "message", { message: { role: "user", content } });
}

function assistant(id, parentId, content, model = { provider: "xai", model: "grok-4.6" }) {
  return entry(id, parentId, "message", { message: { role: "assistant", content, ...model } });
}

test("exports the selected branch as Q&A markdown", () => {
  const entries = [
    user("u1", null, "What is pi-web?"),
    assistant("a1", "u1", [{ type: "text", text: "A browser UI for pi." }]),
    user("u2a", "a1", "branch a"),
    assistant("a2a", "u2a", [{ type: "text", text: "A answer" }]),
    user("u2b", "a1", "branch b"),
    assistant("a2b", "u2b", [{ type: "text", text: "B answer" }]),
  ];

  const result = buildSessionMarkdown(entries, { leafId: "a2a", exportedAt });
  assert.equal(result.ok, true);
  assert.equal(result.fileName, "2026-09-07_What_is_pi-web.md");
  assert.match(
    result.markdown,
    /^---\ntitle: 'What is pi-web\?'\ndate: 2026-09-07T04:12:00Z\nmodel: 'xai\/grok-4\.6'\nturns: 2\n---\n\n# What is pi-web\?/,
  );
  assert.match(result.markdown, /## 1\. What is pi-web\?/);
  assert.match(result.markdown, /A browser UI for pi\./);
  assert.match(result.markdown, /## 2\. branch a/);
  assert.match(result.markdown, /A answer/);
  assert.doesNotMatch(result.markdown, /branch b|B answer/);
  assert.doesNotMatch(result.markdown, /\/home\/|cwd|source:/);
});

test("drops thinking, tool calls, tool results, and tool-only turns", () => {
  const entries = [
    user("u1", null, "fix it"),
    assistant("a1", "u1", [
      { type: "thinking", thinking: "secret plan" },
      { type: "toolCall", toolCallId: "c1", toolName: "bash", input: {} },
    ]),
    entry("t1", "a1", "message", { message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } }),
    assistant("a2", "t1", [{ type: "text", text: "done" }]),
  ];
  const result = buildSessionMarkdown(entries, { leafId: "a2", exportedAt });
  assert.equal(result.ok, true);
  assert.equal(result.turns, 1);
  assert.match(result.markdown, /done/);
  assert.doesNotMatch(result.markdown, /secret plan|bash|toolResult|\bok\b/);
  // Short plain question already captured by the turn heading: no blockquote.
  assert.doesNotMatch(result.markdown, /^> /m);
});

test("prefers session_info name and skips compaction entries", () => {
  const entries = [
    entry("info", null, "session_info", { name: "Named session" }),
    user("u1", "info", "hello"),
    assistant("a1", "u1", [{ type: "text", text: "hi" }]),
    entry("c1", "a1", "compaction", { summary: "compacted" }),
  ];
  const result = buildSessionMarkdown(entries, { leafId: "c1", exportedAt });
  assert.equal(result.ok, true);
  assert.match(result.markdown, /^# Named session/m);
  assert.match(result.markdown, /^title: 'Named session'$/m);
  assert.doesNotMatch(result.markdown, /compacted/);
  assert.equal(result.fileName, "2026-09-07_Named_session.md");
});

test("inlines image placeholders, quotes the question, and rebases answer headings", () => {
  const entries = [
    user("u1", null, [{ type: "text", text: "see this" }, { type: "image", mimeType: "image/png", data: "aaa" }]),
    assistant("a1", "u1", [
      { type: "text", text: "# Heading\n\nbody\n\n```\n# not a heading\n```" },
      { type: "image", source: { type: "base64", data: "bbb" } },
    ]),
  ];
  const result = buildSessionMarkdown(entries, { leafId: "a1", exportedAt });
  assert.equal(result.ok, true);
  assert.equal(result.markdown.split(MARKDOWN_IMAGE_PLACEHOLDER).length - 1, 2);
  assert.match(result.markdown, /^> \*\*Q:\*\* see this$/m);
  assert.match(result.markdown, /^> \[image\]$/m);
  assert.match(result.markdown, /^### Heading$/m);
  assert.match(result.markdown, /```\n# not a heading\n```/);
  assert.doesNotMatch(result.markdown, /^# Heading$/m);
});

test("renders multi-line questions as blockquotes with fenced code intact", () => {
  const entries = [
    user("u1", null, "怎么改这个函数？\n\n```ts\nfunction foo() {\n  return 1;\n}\n```"),
    assistant("a1", "u1", [{ type: "text", text: "这样改。" }]),
  ];
  const result = buildSessionMarkdown(entries, { leafId: "a1", exportedAt });
  assert.equal(result.ok, true);
  assert.match(result.markdown, /^## 1\. 怎么改这个函数？$/m);
  assert.match(result.markdown, /^> \*\*Q:\*\* 怎么改这个函数？$/m);
  assert.match(result.markdown, /^> ```ts$/m);
  assert.match(result.markdown, /^> function foo\(\) \{$/m);
  assert.match(result.markdown, /^这样改。$/m);
});

test("formats frontmatter date and file name in the caller's timezone", () => {
  const entries = [
    user("u1", null, "hello"),
    assistant("a1", "u1", [{ type: "text", text: "hi" }]),
  ];
  const result = buildSessionMarkdown(entries, {
    leafId: "a1",
    exportedAt: new Date("2026-09-07T23:30:00.000Z"),
    timezoneOffsetMinutes: 480,
  });
  assert.equal(result.ok, true);
  assert.match(result.markdown, /^date: 2026-09-08T07:30:00\+08:00$/m);
  assert.equal(result.fileName, "2026-09-08_hello.md");
});

test("quotes YAML scalars and strips list markers from turn titles", () => {
  const entries = [
    entry("info", null, "session_info", { name: "it's a: test" }),
    user("u1", "info", "1. 第一条问题"),
    assistant("a1", "u1", [{ type: "text", text: "答案" }]),
  ];
  const result = buildSessionMarkdown(entries, { leafId: "a1", exportedAt });
  assert.equal(result.ok, true);
  assert.match(result.markdown, /^title: 'it''s a: test'$/m);
  assert.match(result.markdown, /^## 1\. 第一条问题$/m);
});

test("keeps blank-line runs inside fenced code blocks", () => {
  const entries = [
    user("u1", null, "show me"),
    assistant("a1", "u1", [{ type: "text", text: "```\na\n\n\n\nb\n```" }]),
  ];
  const result = buildSessionMarkdown(entries, { leafId: "a1", exportedAt });
  assert.equal(result.ok, true);
  assert.match(result.markdown, /```\na\n\n\n\nb\n```/);
});

test("rebaseHeadings ignores fenced hashes and lifts the document min heading", () => {
  assert.equal(
    rebaseHeadings("# One\n\n## Two", 2),
    "### One\n\n#### Two",
  );
  assert.equal(
    rebaseHeadings("```\n# code\n```\n\n## Real", 2),
    "```\n# code\n```\n\n### Real",
  );
});

test("returns empty when the branch has no assistant text", () => {
  const entries = [
    user("u1", null, "hello"),
    assistant("a1", "u1", [{ type: "thinking", thinking: "hmm" }]),
  ];
  assert.deepEqual(buildSessionMarkdown(entries, { leafId: "a1" }), { ok: false, error: "empty" });
});

test("sanitizeExportFileName strips path characters", () => {
  assert.equal(sanitizeExportFileName('a/b\\c:d*e?f"g<h>i|j'), "abcdefghij");
  assert.equal(sanitizeExportFileName("   "), "session");
});

test("keeps only the answer the chat shows, not narration between tool calls", () => {
  const longNote = `Findings: ${"x".repeat(420)}`;
  const entries = [
    user("u1", null, "check the queue and explain what you found in detail please"),
    assistant("a1", "u1", [
      { type: "text", text: "Let me look at the code." },
      { type: "toolCall", id: "c1", name: "bash", arguments: {} },
    ]),
    entry("t1", "a1", "message", { message: { role: "toolResult", toolCallId: "c1", content: [] } }),
    assistant("a2", "t1", [
      { type: "text", text: longNote },
      { type: "toolCall", id: "c2", name: "bash", arguments: {} },
    ]),
    entry("t2", "a2", "message", { message: { role: "toolResult", toolCallId: "c2", content: [] } }),
    assistant("a3", "t2", [{ type: "text", text: "Final answer." }]),
    user("u2", "a3", "next"),
    assistant("a4", "u2", [{ type: "text", text: "ok" }]),
  ];
  const result = buildSessionMarkdown(entries, {
    leafId: "a4",
    exportedAt,
    locale: "zh-CN",
    sessionId: "s-1",
    createdAt: "2026-09-06T10:00:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.markdown, /Let me look/);
  assert.match(result.markdown, /Findings: x+\n\nFinal answer\./);
  assert.match(result.markdown, /^> \*\*问：\*\* check the queue/m);
  assert.match(result.markdown, /Final answer\.\n\n---\n\n## 2\. next/);
  assert.match(result.markdown, /^created: 2026-09-06T10:00:00Z\nsession: 's-1'$/m);
});

test("puts the question label inline without breaking a leading Markdown block", () => {
  for (const question of ["plain question\n\nmore detail", "```ts\nconst n = 1;\n```", "- first\n- second", "| a | b |\n| --- | --- |\n| 1 | 2 |"] ) {
    const result = buildSessionMarkdown([
      user("u", null, question),
      assistant("a", "u", [{ type: "text", text: "answer" }]),
    ], { exportedAt });
    assert.equal(result.ok, true);
    if (question.startsWith("plain")) {
      assert.match(result.markdown, /> \*\*Q:\*\* plain question\n>\n> more detail/);
    } else {
      assert.ok(result.markdown.includes(`> **Q:**\n>\n> ${question.split("\n")[0]}`));
    }
  }
});

test("preserves nested fences and blank lines in quoted code", () => {
  const code = "````md\n```\n# code heading\n\n\n\nbody\n```\n````";
  assert.equal(rebaseHeadings(`${code}\n\n# Answer`), `${code}\n\n### Answer`);
  const question = `explain this\n\n${code}`;
  const result = buildSessionMarkdown([
    user("u", null, question),
    assistant("a", "u", [{ type: "text", text: "ok" }]),
  ], { exportedAt });
  assert.equal(result.ok, true);
  assert.ok(result.markdown.includes("> # code heading\n>\n>\n>\n> body"));
});

test("question labels preserve reference links, unbordered tables, and thematic breaks", () => {
  const renderQuestion = (question) => {
    const result = buildSessionMarkdown([
      user("u", null, question),
      assistant("a", "u", [{ type: "text", text: "answer" }]),
    ], { exportedAt });
    assert.equal(result.ok, true);
    return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, result.markdown));
  };
  assert.match(renderQuestion("[site]: https://example.com\n\nVisit [site]."), /<a href="https:\/\/example.com">site<\/a>/);
  const table = renderQuestion("a | b\n--- | ---\n1 | 2");
  assert.match(table, /<th>a<\/th><th>b<\/th>/);
  assert.doesNotMatch(table, /<th>[^<]*Q:/);
  for (const marker of ["---", "***", "___", "- - -"]) {
    assert.match(renderQuestion(`${marker}\n\nquestion`), /<blockquote>\s*<p><strong>Q:<\/strong><\/p>\s*<hr\/>/);
  }
  assert.match(renderQuestion("plain question\n\nmore detail"), /<p><strong>Q:<\/strong> plain question<\/p>/);
});
