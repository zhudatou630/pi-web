import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { contextFilesSystemPrompt, createExactSystemPromptExtension } = await createJiti(import.meta.url).import("./chat-only.ts");

test("exact prompt extension replaces Pi's prompt for the next turn", () => {
  let handler;
  const extension = createExactSystemPromptExtension("context prompt");
  extension.factory({ on: (_event, next) => { handler = next; return () => {}; } });
  assert.deepEqual(handler(), { systemPrompt: "context prompt" });
});

test("a function prompt is re-read per run so /reload does not keep a stale prompt", () => {
  let handler;
  let version = 1;
  const extension = createExactSystemPromptExtension(() => `context v${version}`);
  extension.factory({ on: (_event, next) => { handler = next; return () => {}; } });

  assert.deepEqual(handler(), { systemPrompt: "context v1" });
  version = 2;
  assert.deepEqual(handler(), { systemPrompt: "context v2" });
});

test("Chat only preserves Pi context-file order without filtering CLAUDE files", () => {
  const prompt = contextFilesSystemPrompt([
    { path: "/global/AGENTS.md", content: "global agents" },
    { path: "/repo/CLAUDE.md", content: "project claude" },
    { path: "/repo/app/AGENTS.override.md", content: "nested override" },
  ]);
  assert.equal(prompt, "global agents\n\nproject claude\n\nnested override");
});
