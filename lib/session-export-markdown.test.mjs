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
  assert.match(result.markdown, /^# What is pi-web\?/m);
  assert.match(result.markdown, /2026-09-07T04:12:00Z · xai\/grok-4\.6 · 2 turns/);
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
  assert.doesNotMatch(result.markdown, /compacted/);
  assert.equal(result.fileName, "2026-09-07_Named_session.md");
});

test("replaces images with placeholders and rebases headings under the turn", () => {
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
  assert.match(result.markdown, /^### Heading$/m);
  assert.match(result.markdown, /```\n# not a heading\n```/);
  assert.doesNotMatch(result.markdown, /^# Heading$/m);
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
