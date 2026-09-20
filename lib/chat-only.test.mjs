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

test("Chat only preserves Pi context-file order without filtering CLAUDE files", () => {
  const prompt = contextFilesSystemPrompt([
    { path: "/global/AGENTS.md", content: "global agents" },
    { path: "/repo/CLAUDE.md", content: "project claude" },
    { path: "/repo/app/AGENTS.override.md", content: "nested override" },
  ]);
  assert.equal(prompt, "global agents\n\nproject claude\n\nnested override");
});
