import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { displayToolName } = await createJiti(import.meta.url).import("./tool-names.ts");

test("MCP tool names display as server/tool", () => {
  assert.equal(displayToolName("mcp__github__search_code"), "github/search_code");
  assert.equal(displayToolName("mcp__my-srv__get__x"), "my-srv/get__x");
  assert.equal(displayToolName("read"), "read");
});

test("bridge mirrors show as the built-in, tagged with their source", async () => {
  const { toolPresentation } = await createJiti(import.meta.url).import("./tool-names.ts");
  assert.deepEqual(toolPresentation("agy_bash", { command: "ls" }), { label: "bash", source: "agy", as: "bash" });
  assert.deepEqual(toolPresentation("agy_read"), { label: "read", source: "agy", as: "read" });
  assert.deepEqual(toolPresentation("agy_tool", { title: "Web search", kind: "fetch", query: "pi" }), { label: "Web search", source: "agy", as: "fetch" });
  assert.deepEqual(toolPresentation("agy_tool", { title: "Think", kind: "think" }), { label: "Think", source: "agy", as: "agy_tool" });
  assert.deepEqual(toolPresentation("agy_tool", {}), { label: "agy_tool", as: "agy_tool" });
  assert.deepEqual(toolPresentation("agy_todo"), { label: "agy_todo", as: "agy_todo" });
  assert.deepEqual(toolPresentation("mcp__fs__read"), { label: "fs/read", as: "mcp__fs__read" });
  assert.deepEqual(toolPresentation("read"), { label: "read", as: "read" });
});
