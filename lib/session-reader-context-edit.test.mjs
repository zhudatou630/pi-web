import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const { computeSessionStats } = await jiti.import("./session-stats.ts");

/**
 * Pi 0.87 persists retry and overflow recovery as `context_edit` entries: an
 * append-only entry that omits or rewrites an earlier message for the provider
 * while raw history, usage and the UI stay untouched. Pi Web therefore renders
 * the raw transcript and simply must not choke on the new entry type.
 */
function sessionWithContextEdit() {
  return [
    { id: "e1", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "first question" } },
    {
      id: "e2", parentId: "e1", type: "message", timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "abandoned attempt" }],
        stopReason: "error",
        errorMessage: "provider dropped the stream",
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
      },
    },
    // The abandoned attempt is omitted from model context only.
    { id: "e3", parentId: "e2", type: "context_edit", timestamp: "2026-01-01T00:00:02.000Z", targetId: "e2", replacement: null },
    { id: "e4", parentId: "e3", type: "usage", kind: "cache_warm", timestamp: "2026-01-01T00:00:03.000Z", provider: "p", model: "m", usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } } },
    { id: "e5", parentId: "e4", type: "message", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "real answer" }], stopReason: "stop" } },
    { id: "e6", parentId: "e5", type: "message", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "user", content: "second question" } },
  ];
}

test("context_edit and usage entries never render as chat messages", () => {
  const context = buildSessionContext(sessionWithContextEdit(), "e6");
  const roles = context.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "assistant", "user"]);
  // The omitted attempt stays in raw history: `replacement: null` affects model
  // context only, and Pi Web shows what the session file actually recorded.
  assert.ok(context.messages.some((m) => m.role === "assistant" && m.content?.[0]?.text === "abandoned attempt"));
});

test("both new entry types are mapped back to their own entry ids for pagination", () => {
  const context = buildSessionContext(sessionWithContextEdit(), "e6");
  assert.equal(context.entryIds.length, context.messages.length);
  // A phantom id here would break Load earlier / fork navigation.
  assert.ok(!context.entryIds.includes("e3"), "context_edit must not claim a rendered message slot");
  assert.ok(!context.entryIds.includes("e4"), "usage must not claim a rendered message slot");
  assert.deepEqual(context.entryIds, ["e1", "e2", "e5", "e6"]);
});

test("usage entries still reach the token and cost totals", () => {
  const stats = computeSessionStats(sessionWithContextEdit());
  // 10 (assistant) + 5 (cache warm) input tokens across both usage records.
  assert.equal(stats.tokens.input, 15);
  assert.equal(stats.assistantMessages, 2);
  assert.ok(Math.abs(stats.cost - 0.012) < 1e-9);
});
