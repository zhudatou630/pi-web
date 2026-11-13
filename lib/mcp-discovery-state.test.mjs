import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { mcpNeedsCodemode } = await jiti.import("./mcp-view.ts");
const server = { name: "docs", scope: "global", enabled: true, exposure: "codemode", toolExposure: {} };
function settings(names = ["mcp", "codemode"], extra = {}) {
  return { builtins: ["mcp", "codemode", "tool-search"].map((name) => ({ name, enabled: names.includes(name) })), servers: [server], autoEnableCodemode: false, ...extra };
}

test("only enabled, unreplaced servers with discovery exposure need the warning", () => {
  const config = settings();
  assert.equal(mcpNeedsCodemode(server, config, false), true);
  for (const exposure of ["direct", "hidden"]) {
    assert.equal(mcpNeedsCodemode({ ...server, exposure }, config, false), false);
    assert.equal(mcpNeedsCodemode({ ...server, exposure, toolExposure: { lookup: "deferred" } }, config, false), true);
  }
  for (const extra of [{ enabled: false }, { overridden: true }]) {
    assert.equal(mcpNeedsCodemode({ ...server, ...extra }, config, false), false);
  }
  assert.equal(mcpNeedsCodemode(server, settings([]), false), false, "MCP-off has its own actionable notice");
});

test("either discovery tool suffices, including automatic activation by another server", () => {
  assert.equal(mcpNeedsCodemode(server, settings(), true), false);
  assert.equal(mcpNeedsCodemode(server, settings(["mcp"]), true), true, "a selected tool with its extension disabled is unavailable");
  assert.equal(mcpNeedsCodemode(server, settings(["mcp", "tool-search"]), false), false);
  assert.equal(mcpNeedsCodemode(server, settings(undefined, { autoEnableCodemode: undefined }), false), false);
  const deferred = { ...server, exposure: "deferred" };
  assert.equal(mcpNeedsCodemode(deferred, settings(undefined, { autoEnableCodemode: undefined, servers: [deferred] }), false), true);
  assert.equal(mcpNeedsCodemode(deferred, settings(undefined, { autoEnableCodemode: undefined, servers: [deferred, server] }), false), false);
  assert.equal(mcpNeedsCodemode(deferred, settings(undefined, { autoEnableCodemode: undefined, servers: [deferred, { ...server, enabled: false }] }), false), true);
});
