import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getSideChatName, sideChatParentId, sideChatToolGuard, SIDE_CHAT_TYPE } = await jiti.import("./side-chat.ts");

const marker = (parentSessionId) => ({ type: "custom_message", customType: SIDE_CHAT_TYPE, details: { parentSessionId } });
const message = { type: "message" };

test("a branch is a side chat when it holds a marker; the last one names the parent", () => {
  assert.equal(sideChatParentId([message]), undefined);
  assert.equal(sideChatParentId([message, marker("parent")]), "parent");
  assert.equal(sideChatParentId([marker("first"), message, marker("second"), message]), "second");
  assert.equal(sideChatParentId([marker("")]), undefined);
});

test("the guard lets read tools run and refuses the rest only in a side chat", () => {
  let handler;
  sideChatToolGuard({ on: (event, fn) => { if (event === "tool_call") handler = fn; } });
  const ctx = (entries) => ({ sessionManager: { getEntries: () => entries } });
  const side = ctx([message, marker("parent")]);
  for (const toolName of ["read", "grep", "find", "ls"]) assert.equal(handler({ toolName }, side), undefined);
  for (const toolName of ["bash", "edit", "write", "Agent", "codemode", "tool_search", "mcp__fs__write"]) {
    const result = handler({ toolName }, side);
    assert.equal(result?.block, true, toolName);
    assert.match(result.reason, /side chat/);
  }
  assert.equal(handler({ toolName: "edit" }, ctx([message])), undefined);
});

test("a side chat is named after its question, not its quotes", () => {
  assert.equal(getSideChatName("  why\n does   this fail? ", "Side: "), "Side: why does this fail?");
  assert.equal(getSideChatName('<quote source="abc">\nquoted text\n</quote>\n\nwhat is this', "Side: "), "Side: what is this");
  assert.equal(getSideChatName('<quote source="abc">\nquoted text\n</quote>', "Side: "), "Side: quoted text");
  assert.equal(getSideChatName("x".repeat(80), "").length, 60);
});
