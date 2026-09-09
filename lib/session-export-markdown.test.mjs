import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

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
  assert.match(result.markdown, /^> see this$/m);
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
  assert.match(result.markdown, /^> 怎么改这个函数？$/m);
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
