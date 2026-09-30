import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { displayToolName } = await createJiti(import.meta.url).import("./tool-names.ts");

test("MCP tool names display as server/tool", () => {
  assert.equal(displayToolName("mcp__github__search_code"), "github/search_code");
  assert.equal(displayToolName("mcp__my-srv__get__x"), "my-srv/get__x");
  assert.equal(displayToolName("read"), "read");
});
