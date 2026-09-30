import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { readOnlyToolGuard } = await createJiti(import.meta.url).import("./read-only-tool-guard.ts");

function guard(active) {
  let handler;
  readOnlyToolGuard({
    on: (_event, fn) => { handler = fn; },
    getActiveTools: () => active,
    getAllTools: () => [
      { name: "mcp__gh__get_issue", annotations: { readOnlyHint: true } },
      { name: "mcp__gh__delete_repo", annotations: {} },
    ],
  });
  return (toolName) => handler({ type: "tool_call", toolName, toolCallId: "1", input: {} })?.block === true;
}

test("read-only sessions run no MCP tool, whatever the server claims", () => {
  const readOnly = guard(["read", "grep", "codemode"]);
  assert.equal(readOnly("mcp__gh__get_issue"), true, "readOnlyHint is not trusted");
  assert.equal(readOnly("mcp__gh__delete_repo"), true);
  assert.equal(readOnly("read"), false);
  assert.equal(readOnly("read_mcp_resource"), false);

  const writable = guard(["read", "bash", "codemode"]);
  assert.equal(writable("mcp__gh__delete_repo"), false);
});
