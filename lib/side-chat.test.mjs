import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getSideChatName, sideChatParentId, sideChatToolGuard } = await jiti.import("./side-chat.ts");

const header = (side) => ({ type: "session", id: "s", ...(side ? { piWebSide: side } : {}) });

test("the header names a side chat's main session", () => {
  assert.equal(sideChatParentId(header()), undefined);
  assert.equal(sideChatParentId(header({ parentSessionId: "main" })), "main");
  assert.equal(sideChatParentId(header({ parentSessionId: "" })), undefined);
  assert.equal(sideChatParentId(null), undefined);
});

test("the guard lets read tools run and refuses the rest only in a side chat", () => {
  let handler;
  sideChatToolGuard({ on: (event, fn) => { if (event === "tool_call") handler = fn; } });
  const ctx = (h) => ({ sessionManager: { getHeader: () => h } });
  const side = ctx(header({ parentSessionId: "main" }));
  for (const toolName of ["read", "grep", "find", "ls"]) assert.equal(handler({ toolName }, side), undefined);
  for (const toolName of ["bash", "edit", "write", "Agent", "codemode", "tool_search", "mcp__fs__write"]) {
    const result = handler({ toolName }, side);
    assert.equal(result?.block, true, toolName);
    assert.match(result.reason, /side chat/);
  }
  assert.equal(handler({ toolName: "edit" }, ctx(header())), undefined);
});

test("a side chat is named after its question, not its quotes", () => {
  assert.equal(getSideChatName("  why\n does   this fail? ", "Side: "), "Side: why does this fail?");
  assert.equal(getSideChatName('<quote source="abc">\nquoted text\n</quote>\n\nwhat is this', "Side: "), "Side: what is this");
  assert.equal(getSideChatName('<quote source="abc">\nquoted text\n</quote>', "Side: "), "Side: quoted text");
  assert.equal(getSideChatName("x".repeat(80), "").length, 60);
});
