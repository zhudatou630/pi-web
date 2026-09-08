import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { workspaceKeyOf } = await jiti.import("./workspace-key.ts");

test("workspace identity prefers the server-resolved key", () => {
  assert.equal(workspaceKeyOf({ cwd: "/worktree", projectRoot: "/repo", projectKey: "repo-key" }), "repo-key");
});

test("workspace identity falls back through project root to cwd", () => {
  assert.equal(workspaceKeyOf({ cwd: "/worktree", projectRoot: "/repo" }), "/repo");
  assert.equal(workspaceKeyOf({ cwd: "/standalone" }), "/standalone");
});
