import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildSessionOutline, userMessagePreview } = await jiti.import("./session-reader.ts");

test("userMessagePreview flattens text and truncates", () => {
  assert.equal(userMessagePreview("  hello   world  "), "hello world");
  assert.equal(userMessagePreview([{ type: "text", text: "one" }, { type: "text", text: "two" }]), "one two");
  assert.equal(userMessagePreview("x".repeat(130)).endsWith("…"), true);
  assert.equal(userMessagePreview("x".repeat(130)).length, 121);
});

test("buildSessionOutline walks the active branch and keeps user prompts only", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message", timestamp: "t1", message: { role: "user", content: "first" } },
    { id: "a1", parentId: "u1", type: "message", timestamp: "t2", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "c1", toolName: "bash", input: {} }] } },
    { id: "u2", parentId: "a1", type: "message", timestamp: "t3", message: { role: "user", content: "second" } },
    { id: "a2", parentId: "u2", type: "message", timestamp: "t4", message: { role: "assistant", content: "done" } },
  ];
  assert.deepEqual(buildSessionOutline(entries, "a2"), [
    { entryId: "u1", preview: "first" },
    { entryId: "u2", preview: "second" },
  ]);
});

test("buildSessionOutline follows the selected leaf, not later siblings", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message", timestamp: "t1", message: { role: "user", content: "root" } },
    { id: "u2", parentId: "u1", type: "message", timestamp: "t2", message: { role: "user", content: "branch a" } },
    { id: "u3", parentId: "u1", type: "message", timestamp: "t3", message: { role: "user", content: "branch b" } },
  ];
  assert.deepEqual(buildSessionOutline(entries, "u2"), [
    { entryId: "u1", preview: "root" },
    { entryId: "u2", preview: "branch a" },
  ]);
});
