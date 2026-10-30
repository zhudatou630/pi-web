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
  projectDisplayName,
  projectNamesFit,
  isProjectNames,
  MAX_PROJECT_ORDER_KEYS,
  PROJECT_ORDER_MAX_BYTES,
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

test("project display names: trimmed, one line, 80 code points; null or empty clears; stored names must fit", () => {
  assert.equal(projectDisplayName("  Work  "), "Work");
  assert.equal(projectDisplayName("   "), "");
  assert.equal(projectDisplayName(null), "");
  assert.equal(projectDisplayName(undefined), undefined);
  assert.equal(projectDisplayName(42), undefined);
  assert.equal(projectDisplayName("a\nb"), undefined);
  assert.equal(projectDisplayName("a\tb"), undefined);
  assert.equal(projectDisplayName("a".repeat(80)), "a".repeat(80));
  assert.equal(projectDisplayName("a".repeat(81)), undefined);
  // Code points, not UTF-16 units: 80 emoji fit.
  assert.equal(projectDisplayName("😀".repeat(80)), "😀".repeat(80));
  assert.equal(projectDisplayName("😀".repeat(81)), undefined);

  assert.equal(isProjectNames({ "/work/a": "A" }), true);
  assert.equal(isProjectNames({ "/work/a": "" }), false);
  assert.equal(isProjectNames({ "/work/a": 1 }), false);
  assert.equal(isProjectNames(JSON.parse('{"__proto__":"x"}')), false);
  assert.equal(isProjectNames(["x"]), false);

  // Count cap first; then the JSON byte cap (each padded entry is ~611 bytes).
  const names = (count, keyPad = "") => Object.fromEntries(Array.from({ length: count }, (_, i) => [`/${keyPad}${i}`, "a"]));
  assert.equal(projectNamesFit(names(1000)), true);
  assert.equal(projectNamesFit(names(1001)), false);
  const padded = "k".repeat(600);
  assert.equal(projectNamesFit(names(420, padded)), true);
  assert.equal(projectNamesFit(names(430, padded)), false);
});

test("Windows path variants form one recent project using the newest display path", () => {
  const older = session("older", "C:\\Users\\Alex\\Project\\Study\\ELM", "2026-08-12T00:00:00.000Z");
  const newer = session("newer", "c:/users/ALEX/project/study/elm", "2026-08-13T00:00:00.000Z");

  assert.deepEqual(getRecentProjects([older, newer]), [{
    key: older.projectKey,
    root: newer.projectRoot,
  }]);
});

test("awaiting families are separate from running without changing the protective running set", () => {
  const root = session("root", "/project", "2026-01-01T00:00:00.000Z");
  const child = { ...root, id: "child", relation: { kind: "subagent", parentSessionId: "root" } };
  const running = new Set(["root", "child"]);
  const activity = getProjectActivity([root, child], running, new Set(), new Set(["child"]));
  assert.deepEqual(activity.get(root.projectKey), { running: 0, awaiting: 1, unread: 0 });
  assert.deepEqual([...running], ["root", "child"]);
});

test("running and unread counts aggregate under the stable project identity", () => {
  const first = session("first", "C:\\Users\\Alex\\Project", "2026-08-12T00:00:00.000Z");
  const second = session("second", "c:/users/alex/project/", "2026-08-13T00:00:00.000Z");

  const activity = getProjectActivity(
    [first, second],
    new Set(["first", "second"]),
    new Set(["second"]),
    new Set(),
  );

  assert.deepEqual(activity.get(first.projectKey), { running: 2, awaiting: 0, unread: 1 });
  assert.equal(activity.size, 1);
});

test("collapsed activity counts a family once even when several members are active", () => {
  const root = session("root", "/project", "2026-01-01T00:00:00.000Z");
  const children = ["child", "grandchild"].map((id) => ({ ...root, id, relation: { kind: "subagent", parentSessionId: "root" } }));
  const activity = getProjectActivity([root, ...children], new Set(["root", "child", "grandchild"]), new Set(["root", "child"]), new Set());
  assert.deepEqual(activity.get(root.projectKey), { running: 1, awaiting: 0, unread: 1 });
});
