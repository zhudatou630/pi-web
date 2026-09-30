import assert from "node:assert/strict";
import test from "node:test";

const { buildBranchRows } = await import("./branch-rows.ts");
const { projectTreeForResponse } = await import("./project-tree.ts");

const msg = (id, role, text, timestamp) => ({ type: "message", id, parentId: null, timestamp, message: { role, content: text } });
const model = (id) => ({ type: "model_change", id, parentId: null, timestamp: "0", provider: "p", modelId: "m" });
const node = (entry, children = []) => ({ entry, children });

// (model) q1 a1 q2 a2 ─┬─ 加测试 a3 ─┬─ bench a4
//                      │             └─ lint  a4b
//                      └─ 解释 a3b
function sampleTree() {
  const a3 = node(msg("a3", "assistant", "ok", "2"), [
    node(msg("u4", "user", "bench", "3"), [node(msg("a4", "assistant", "ok", "4"))]),
    node(msg("u4b", "user", "lint", "3"), [node(msg("a4b", "assistant", "ok", "5"))]),
  ]);
  const a2 = node(msg("a2", "assistant", "ok", "1"), [
    node(msg("u3", "user", "加测试", "2"), [a3]),
    node(msg("u3b", "user", "解释", "2"), [node(msg("a3b", "assistant", "ok", "6"))]),
  ]);
  const chain = node(msg("u1", "user", "q1", "0"), [node(msg("a1", "assistant", "ok", "0"), [node(msg("u2", "user", "q2", "0"), [a2])])]);
  return projectTreeForResponse([node(model("m0"), [chain])]);
}

const summary = (rows) => rows.map((r) => [r.preview, r.turnStart, r.turnEnd, r.levels.join(""), r.connector, r.onPath, r.current, r.leafId]);

test("draws the trunk once, forks indent, and the current version comes first", () => {
  assert.deepEqual(summary(buildBranchRows(sampleTree(), "a4")), [
    ["q1", 1, 2, "", null, true, false, null],
    ["加测试", 3, 3, "", "branch", true, false, null],
    ["bench", 4, 4, "pass", "branch", true, true, null],
    ["lint", 4, 4, "pass", "last", false, false, "a4b"],
    ["解释", 3, 3, "", "last", false, false, "a3b"],
  ]);
});

test("each row anchors on the first user message of its segment", () => {
  assert.deepEqual(buildBranchRows(sampleTree(), "a4").map((r) => r.anchorId), ["u1", "u3", "u4", "u4b", "u3b"]);
});

test("switching target of an inactive version is its newest leaf", () => {
  const rows = buildBranchRows(sampleTree(), "a3b");
  assert.deepEqual(rows.map((r) => [r.preview, r.current, r.leafId]), [
    ["q1", false, null],
    ["解释", true, null],
    ["加测试", false, "a4b"],
    ["bench", false, "a4"],
    ["lint", false, "a4b"],
  ]);
});

test("multiple roots become sibling rows; a linear session is one row", () => {
  const roots = projectTreeForResponse([
    node(msg("u1", "user", "第一问", "1"), [node(msg("a1", "assistant", "ok", "1"))]),
    node(msg("u2", "user", "改问", "2"), [node(msg("a2", "assistant", "ok", "2"))]),
  ]);
  assert.deepEqual(buildBranchRows(roots, "a2").map((r) => [r.preview, r.connector, r.current]), [["改问", "branch", true], ["第一问", "last", false]]);
  assert.equal(buildBranchRows(projectTreeForResponse([node(msg("u1", "user", "q", "1"), [node(msg("a1", "assistant", "ok", "1"))])]), "a1").length, 1);
});

test("a 6000-deep linear chain does not overflow the stack", () => {
  const root = node(msg("e0", "user", "q", "1"));
  let tail = root;
  for (let i = 1; i < 6000; i++) {
    const next = node(msg(`e${i}`, i % 2 ? "assistant" : "user", "x", "1"));
    tail.children.push(next);
    tail = next;
  }
  assert.equal(buildBranchRows([root], "e5999").length, 1);
});
