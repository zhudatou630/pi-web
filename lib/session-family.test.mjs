import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { getSessionFamily, listSessionFamilies, isFamilyArchived, familiesToArchive, previewSessionFamilies, markSessionFamilyRead } = await createJiti(import.meta.url).import("./session-family.ts");

function session(id, modified, relation) {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/tmp",
    created: modified,
    modified,
    messageCount: 1,
    firstMessage: id,
    ...(relation ? { relation } : {}),
  };
}

test("groups nested subagents under their main session and uses family activity for sorting", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const child = session("child", "2026-01-04T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Explore", status: "completed",
  });
  const grandchild = session("grandchild", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "child", profile: "review", description: "Review", status: "running",
  });
  const newerRoot = session("newer-root", "2026-01-02T00:00:00.000Z");

  const families = listSessionFamilies([main, child, grandchild, newerRoot]);
  assert.deepEqual(families.map((family) => family.root.id), ["main", "newer-root"]);
  assert.deepEqual(families[0].subagents.map((item) => item.id), ["child", "grandchild"]);
  assert.equal(getSessionFamily([main, child, grandchild], "grandchild")?.root.id, "main");
});

test("does not promote orphaned or cyclic subagent metadata into the main session list", () => {
  const orphan = session("orphan", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "missing", profile: "explore", description: "Explore", status: "interrupted",
  });
  const a = session("a", "2026-01-01T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "b", profile: "a", description: "A", status: "interrupted",
  });
  const b = session("b", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "a", profile: "b", description: "B", status: "interrupted",
  });

  assert.deepEqual(listSessionFamilies([orphan, a, b]), []);
  assert.equal(getSessionFamily([orphan, a, b], "orphan"), null);
});

test("effective archive follows root message activity, not subagent activity or running members", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const child = session("child", "2026-01-04T00:00:00.000Z", { kind: "subagent", parentSessionId: "main" });
  const family = listSessionFamilies([main, child])[0];
  const archived = { main: main.modified };
  assert.equal(isFamilyArchived(family, {}, new Set()), false);
  assert.equal(isFamilyArchived(family, archived, new Set()), true);
  assert.equal(isFamilyArchived(family, archived, new Set(["main"])), false);
  assert.equal(isFamilyArchived(family, archived, new Set(["child"])), false);
  assert.equal(isFamilyArchived(family, archived, new Set(["unrelated"])), true);
  main.modified = "2026-01-02T00:00:00.000Z";
  assert.equal(isFamilyArchived(family, archived, new Set()), false);
});

test("archive-older skips every protected kind and uses latest family activity with a strict seven-day cutoff", () => {
  const old = "2026-01-01T00:00:00.000Z";
  const now = Date.parse("2026-02-01T00:00:00.000Z");
  const sessions = ["eligible", "archived", "pinned", "running", "unread", "selected", "visible", "recentChild", "boundary", "invalid", "transient", "other", "resurfaced"].map((id) => session(id, old));
  sessions.find((s) => s.id === "boundary").modified = new Date(now - 7 * 86400000).toISOString();
  sessions.find((s) => s.id === "invalid").modified = "invalid";
  sessions.find((s) => s.id === "transient").transient = true;
  sessions.find((s) => s.id === "other").cwd = "/other";
  sessions.push(...["running", "unread", "selected", "visible", "recentChild"].map((root) => session(`${root}-child`, root === "recentChild" ? "2026-01-31T00:00:00.000Z" : old, { kind: "subagent", parentSessionId: root })));
  const selected = familiesToArchive({
    families: listSessionFamilies(sessions), projectKey: "/tmp", now,
    archived: { archived: old, resurfaced: "2025-12-01T00:00:00.000Z" },
    pinnedIds: new Set(["pinned"]), runningIds: new Set(["running-child"]), unreadIds: new Set(["unread-child"]),
    selectedSessionId: "selected-child", visibleSessionIds: new Set(["visible-child"]),
  });
  assert.deepEqual(new Set(selected.map((f) => f.root.id)), new Set(["eligible", "resurfaced"]));
});

test("show-less keeps old running, unread and selected families without consuming a page", () => {
  const families = listSessionFamilies(Array.from({ length: 10 }, (_, i) => session(String(i), new Date(Date.UTC(2026, 0, 10 - i)).toISOString())));
  const forced = new Set(["7", "8", "9"]);
  const collapsed = previewSessionFamilies(families, 6, 0, forced);
  assert.deepEqual(collapsed.visible.map((f) => f.root.id), ["0", "1", "2", "3", "4", "5", "7", "8", "9"]);
  assert.equal(collapsed.revealed, 0);
  const expanded = previewSessionFamilies(families, 6, 20, forced);
  assert.equal(expanded.visible.length, 10);
  assert.equal(expanded.revealed, 1);
  const withChild = { ...families[6], subagents: [session("forced-child", families[6].latestModified)] };
  assert.equal(previewSessionFamilies([families[0], withChild], 1, 0, new Set(["forced-child"])).visible.length, 2);
});

test("manual read clears the family, unread marks only its root, and unrelated markers survive", () => {
  const family = { root: session("main", "2026-01-01"), subagents: [session("child", "2026-01-01")], latestModified: "2026-01-01" };
  const ids = new Set(["main", "child", "other"]);
  assert.deepEqual(markSessionFamilyRead(family, ids, true), new Set(["other"]));
  assert.deepEqual(markSessionFamilyRead(family, ids, false), new Set(["main", "other"]));
  assert.deepEqual(ids, new Set(["main", "child", "other"]), "input is not mutated");
});
