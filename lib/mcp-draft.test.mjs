import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { parseMcpDraft } = await createJiti(import.meta.url).import("./mcp-draft.ts");

test("a draft is one config, a name map, or a pasted mcpServers block", () => {
  assert.deepEqual(parseMcpDraft("fs", '{"command":"npx"}'), [["fs", { command: "npx" }]]);
  assert.deepEqual(parseMcpDraft("", '{"mcpServers":{"a":{"url":"u"},"b":{"command":"c"}}}'), [["a", { url: "u" }], ["b", { command: "c" }]]);
  assert.deepEqual(parseMcpDraft("mine", '{"a":{"url":"u"}}'), [["mine", { url: "u" }]]);
  assert.throws(() => parseMcpDraft("x", "[]"));
  assert.throws(() => parseMcpDraft("x", "{}"));
});
