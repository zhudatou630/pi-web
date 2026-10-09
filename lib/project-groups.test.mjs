import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { projectIdentityKey } = await jiti.import("./project-identity.ts");
const {
  getProjectActivity,
  getRecentProjects,
  orderProjects,
  applyProjectOrderUpdate,
  projectOrderFits,
  MAX_PROJECT_ORDER_KEYS,
  PROJECT_ORDER_MAX_BYTES,
  sessionsForProject,
} = await jiti.import("./project-groups.ts");

test("stored project slots survive new activity, hidden projects, and newly discovered projects", () => {
  const a = session("a", "/a", "2026-01-01T00:00:00.000Z");
  const b = session("b", "/b", "2026-01-02T00:00:00.000Z");
  const new1 = session("new1", "/new1", "2026-01-03T00:00:00.000Z");
  const new2 = session("new2", "/new2", "2026-01-04T00:00:00.000Z");
  const stored = [a.projectKey, "hidden", b.projectKey];
  assert.deepEqual(getRecentProjects([b, { ...a, modified: "2099-01-01T00:00:00.000Z" }], stored).map((p) => p.key), [a.projectKey, b.projectKey]);
  const projects = getRecentProjects([a, b, new1, new2], stored);
  assert.deepEqual(projects.map((p) => p.key), [new2.projectKey, new1.projectKey, a.projectKey, b.projectKey]);
  const added = applyProjectOrderUpdate(stored, { addProjects: projects.map((p) => p.key) });
  assert.deepEqual(orderProjects(projects, added), projects, "saving must not change the visible order");
  assert.deepEqual(applyProjectOrderUpdate(added, { addProjects: [...projects.map((p) => p.key), new1.projectKey] }), added);
  assert.ok(added.includes("hidden"));
  assert.deepEqual(stored, [a.projectKey, "hidden", b.projectKey], "pure functions do not mutate inputs");
});

test("relative moves replay on current state and preserve unrelated moves and hidden slots", () => {
  const stored = ["a", "hidden", "b", "c", "d"];
  const first = applyProjectOrderUpdate(stored, { move: "d", before: "b" });
  const second = applyProjectOrderUpdate(first, { move: "c", before: "a" });
  assert.deepEqual(second, ["c", "a", "hidden", "d", "b"]);
  assert.deepEqual(applyProjectOrderUpdate(second, { move: "c", before: "a" }), second);
  assert.deepEqual(applyProjectOrderUpdate(stored, { move: "a", after: "b" }), ["hidden", "b", "a", "c", "d"]);
  assert.deepEqual(applyProjectOrderUpdate(["old"], { move: "new1", after: "new2", addProjects: ["new1", "new2"] }), ["new2", "new1", "old"]);
  assert.deepEqual(applyProjectOrderUpdate(["old"], { move: "new1", before: "new2" }), ["new1", "new2", "old"]);
});

test("project order caps keys and escaped UTF-8 bytes; add never evicts a saved key", () => {
  const full = Array.from({ length: MAX_PROJECT_ORDER_KEYS }, (_, i) => `key-${i}`);
  assert.equal(projectOrderFits(full), true);
  assert.deepEqual(applyProjectOrderUpdate(full, { addProjects: ["new"] }), full);
  const almostFull = full.slice(0, -1);
  const capped = applyProjectOrderUpdate(almostFull, { addProjects: ["new1", "new2"] });
  assert.deepEqual(capped, ["new2", ...almostFull]);
  assert.deepEqual(orderProjects(["new1", "new2", ...almostFull].map((key) => ({ key })), capped).map((p) => p.key), ["new1", "new2", ...almostFull]);
  const longKeys = Array.from({ length: 500 }, (_, i) => `${i}-` + "\\中".repeat(1000));
  const bytesCapped = applyProjectOrderUpdate(["saved"], { addProjects: longKeys });
  assert.equal(bytesCapped.at(-1), "saved");
  assert.ok(Buffer.byteLength(JSON.stringify(bytesCapped)) <= PROJECT_ORDER_MAX_BYTES);
  assert.deepEqual(applyProjectOrderUpdate(bytesCapped, { addProjects: longKeys }), bytesCapped);
  const moved = applyProjectOrderUpdate(full, { move: "new", before: "key-0" });
  assert.deepEqual(moved.slice(0, 2), ["new", "key-0"]);
  assert.equal(projectOrderFits(moved), true);
  assert.equal(moved.length, 1000);
  const oversizedMove = applyProjectOrderUpdate(["saved"], { move: longKeys[0], after: longKeys[1], addProjects: longKeys });
  assert.equal(projectOrderFits(oversizedMove), true);
  assert.equal(oversizedMove.indexOf(longKeys[0]), oversizedMove.indexOf(longKeys[1]) + 1);
});

function session(id, projectRoot, modified) {
  return {
    id,
    path: `${id}.jsonl`,
    cwd: projectRoot,
    projectRoot,
    projectKey: projectIdentityKey(projectRoot, "win32"),
    created: modified,
    modified,
    messageCount: 1,
    firstMessage: id,
  };
}

test("Windows path variants form one recent project using the newest display path", () => {
  const older = session("older", "C:\\Users\\Alex\\Project\\Study\\ELM", "2026-08-12T00:00:00.000Z");
  const newer = session("newer", "c:/users/ALEX/project/study/elm", "2026-08-13T00:00:00.000Z");

  assert.deepEqual(getRecentProjects([older, newer]), [{
    key: older.projectKey,
    root: newer.projectRoot,
  }]);
});

test("project filtering includes every session with the stable identity", () => {
  const first = session("first", "C:\\Users\\Alex\\Project", "2026-08-12T00:00:00.000Z");
  const second = session("second", "c:/users/alex/project/", "2026-08-13T00:00:00.000Z");
  const other = session("other", "D:\\Elsewhere", "2026-08-13T01:00:00.000Z");

  assert.deepEqual(
    sessionsForProject([first, second, other], first.projectKey).map((item) => item.id),
    ["first", "second"],
  );
});

test("running and unread counts aggregate under the stable project identity", () => {
  const first = session("first", "C:\\Users\\Alex\\Project", "2026-08-12T00:00:00.000Z");
  const second = session("second", "c:/users/alex/project/", "2026-08-13T00:00:00.000Z");

  const activity = getProjectActivity(
    [first, second],
    new Set(["first", "second"]),
    new Set(["second"]),
  );

  assert.deepEqual(activity.get(first.projectKey), { running: 2, unread: 1 });
  assert.equal(activity.size, 1);
});

test("collapsed activity counts a family once even when several members are active", () => {
  const root = session("root", "/project", "2026-01-01T00:00:00.000Z");
  const children = ["child", "grandchild"].map((id) => ({ ...root, id, relation: { kind: "subagent", parentSessionId: "root" } }));
  const activity = getProjectActivity([root, ...children], new Set(["root", "child", "grandchild"]), new Set(["root", "child"]));
  assert.deepEqual(activity.get(root.projectKey), { running: 1, unread: 1 });
});
