import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { computeContextBreakdown } = await jiti.import("./context-breakdown.ts");

const tool = (name) => ({ name, description: "d", parameters: { type: "object", properties: {} } });

test("counts the replayed system prompt and tools once", () => {
  const messages = [
    {
      role: "system",
      content: "",
      sections: { preamble: "a".repeat(40), project_context: "b".repeat(80), skills: "c".repeat(40), cwd: "d".repeat(8) },
      toolsAdded: [tool("read"), tool("bash")],
      timestamp: 1,
    },
    { role: "user", content: "u".repeat(40), timestamp: 2 },
    // A later patch replaces a section and drops a tool; it must not count twice.
    { role: "system", content: "", sections: { project_context: "e".repeat(20), cwd: null }, toolsRemoved: [{ name: "bash" }], timestamp: 3 },
  ];
  const result = computeContextBreakdown(messages);
  // preamble 40 + project_context 20 + skills 40; cwd was removed.
  assert.equal(result.systemPrompt, 25);
  assert.equal(result.tools, Math.ceil(JSON.stringify([tool("read")]).length / 4));
  assert.equal(result.conversation, 10);
  assert.equal(result.toolResults, 0);
});

test("counts tool results separately from the conversation", () => {
  const result = computeContextBreakdown([
    { role: "user", content: [{ type: "text", text: "x".repeat(8) }], timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "t".repeat(8) }, { type: "toolCall", id: "c", name: "read", arguments: {} }],
      timestamp: 2,
    },
    { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "r".repeat(400) }], timestamp: 3 },
    { role: "compactionSummary", summary: "s".repeat(40), tokensBefore: 1, timestamp: 4 },
    { role: "bashExecution", command: "ls", output: "o".repeat(400), exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 5 },
  ]);
  assert.deepEqual(result, { systemPrompt: 0, tools: 0, conversation: 2 + 4 + 10, toolResults: 100 });
});
