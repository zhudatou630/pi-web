import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { shouldAdoptSessionCwd } = await createJiti(import.meta.url).import("./explorer-cwd.ts");

const main = { path: "/repo" };
const feature = { path: "/repo-worktrees/feature" };
const worktrees = [main, feature];

test("adopts the first cwd when explorer has no folder yet", () => {
  assert.equal(shouldAdoptSessionCwd({ sessionCwd: "/repo", selectedCwd: null }), true);
});

test("keeps explorer still for another session in the same live worktree", () => {
  assert.equal(shouldAdoptSessionCwd({
    sessionCwd: "/repo",
    selectedCwd: "/repo",
    worktrees,
  }), false);
});

test("moves explorer when the session lives in a different live worktree", () => {
  assert.equal(shouldAdoptSessionCwd({
    sessionCwd: feature.path,
    selectedCwd: main.path,
    worktrees,
  }), true);
  assert.equal(shouldAdoptSessionCwd({
    sessionCwd: main.path,
    selectedCwd: feature.path,
    worktrees,
  }), true);
});

test("ignores a dead worktree path instead of yanking explorer off the live checkout", () => {
  assert.equal(shouldAdoptSessionCwd({
    sessionCwd: "/repo-worktrees/deleted",
    selectedCwd: "/repo",
    worktrees,
  }), false);
});

test("follows a different cwd when the project is not a worktree repo", () => {
  assert.equal(shouldAdoptSessionCwd({
    sessionCwd: "/notes",
    selectedCwd: "/other",
    worktrees: [],
  }), true);
});

test("does not adopt a missing session cwd", () => {
  assert.equal(shouldAdoptSessionCwd({ sessionCwd: "", selectedCwd: "/repo" }), false);
  assert.equal(shouldAdoptSessionCwd({ sessionCwd: null, selectedCwd: "/repo" }), false);
});
