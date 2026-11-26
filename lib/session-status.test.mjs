import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { sessionStatus, mostUrgentStatus, unseenErrorSessionIds, truncateStatusReason } = await jiti.import("./session-status.ts");

test("one state per row: awaiting, then error, then unread, then running", () => {
  assert.equal(sessionStatus({ awaiting: true, running: true }), "awaiting");
  assert.equal(sessionStatus({ error: true, unread: true, running: true }), "error");
  assert.equal(sessionStatus({ unread: true, running: true }), "unread");
  assert.equal(sessionStatus({ running: true }), "running");
  assert.equal(sessionStatus({}), null);
});

test("a folded group shows only its most urgent state", () => {
  assert.equal(mostUrgentStatus(["running", "unread", null]), "unread");
  assert.equal(mostUrgentStatus(["running", "error", "unread"]), "error");
  assert.equal(mostUrgentStatus(new Set(["error", "awaiting"])), "awaiting");
  assert.equal(mostUrgentStatus([null, undefined]), null);
});

test("an error shows until a shared read after it, and never while running or on screen", () => {
  const sessions = [
    { id: "a", lastError: { at: 100, message: "boom" } },
    { id: "read", lastError: { at: 100, message: "boom" } },
    { id: "readBefore", lastError: { at: 100, message: "boom" } },
    { id: "retrying", lastError: { at: 100, message: "boom" } },
    { id: "visible", lastError: { at: 100, message: "boom" } },
    { id: "ok" },
    { id: "sub", lastError: { at: 100, message: "boom" }, relation: { kind: "subagent" } },
    { id: "side", lastError: { at: 100, message: "boom" }, relation: { kind: "side" } },
    { id: "fork", lastError: { at: 100, message: "boom" }, relation: { kind: "fork" } },
    { id: "routine", lastError: { at: 100, message: "boom" }, routineRunOnly: true },
  ];
  const ids = unseenErrorSessionIds(sessions, { read: 100, readBefore: 99 }, new Set(["retrying"]), new Set(["visible"]));
  assert.deepEqual([...ids].sort(), ["a", "fork", "readBefore"]);
});

test("reasons are one line of at most 120 characters", () => {
  assert.equal(truncateStatusReason("  Overwrite\n  pinned?  "), "Overwrite pinned?");
  const long = truncateStatusReason("x".repeat(200));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"));
});
