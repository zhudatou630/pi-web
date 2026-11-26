import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { groupByStatus, parseSidebarGrouping, readAllTargets } = await jiti.import("./sidebar-grouping.ts");
const { hasBlockedSession } = await jiti.import("./session-status.ts");

test("status grouping: blocking before unread, each newest first; running and recent apart", () => {
  const items = [
    { id: "unreadOld", status: "unread", at: 1 },
    { id: "recentOld", status: null, at: 2 },
    { id: "errorOld", status: "error", at: 3 },
    { id: "run", status: "running", at: 4 },
    { id: "unreadNew", status: "unread", at: 5 },
    { id: "waitNew", status: "awaiting", at: 6 },
    { id: "recentNew", status: null, at: 7 },
    { id: "runNew", status: "running", at: 8 },
  ];
  const groups = groupByStatus(items, (item) => item.status, (item) => item.at);
  assert.deepEqual(groups.needsYou.map((item) => item.id), ["waitNew", "errorOld", "unreadNew", "unreadOld"]);
  assert.deepEqual(groups.running.map((item) => item.id), ["runNew", "run"]);
  assert.deepEqual(groups.recent.map((item) => item.id), ["recentNew", "recentOld"]);
});

test("status grouping leaves empty groups empty", () => {
  const groups = groupByStatus([{ status: null, at: 1 }], (item) => item.status, (item) => item.at);
  assert.equal(groups.needsYou.length, 0);
  assert.equal(groups.running.length, 0);
  assert.equal(groups.recent.length, 1);
});

test("the grouping choice defaults to by project", () => {
  assert.equal(parseSidebarGrouping("status"), "status");
  assert.equal(parseSidebarGrouping("project"), "project");
  assert.equal(parseSidebarGrouping(null), "project");
  assert.equal(parseSidebarGrouping("junk"), "project");
});

test("mark all as read targets unread families and unseen errors, reaching the error's time", () => {
  const family = (id, lastError, subagents = []) => ({ root: { id, lastError }, subagents: subagents.map((sub) => ({ id: sub })), latestModified: "" });
  const families = [
    family("unread"),
    family("subUnread", undefined, ["child"]),
    family("errored", { at: 500, message: "boom" }),
    family("erroredOld", { at: 50, message: "boom" }),
    family("quiet"),
  ];
  const targets = readAllTargets(families, new Set(["unread", "child"]), new Set(["errored", "erroredOld"]), 100);
  assert.deepEqual([...targets], [["unread", 100], ["subUnread", 100], ["errored", 500], ["erroredOld", 100]]);
});

test("the phone menu button marks waiting or errored sessions only", () => {
  const empty = new Set();
  assert.equal(hasBlockedSession({ awaitingInput: empty, error: empty }), false);
  assert.equal(hasBlockedSession({ awaitingInput: new Set(["a"]), error: empty }), true);
  assert.equal(hasBlockedSession({ awaitingInput: empty, error: new Set(["b"]) }), true);
});
