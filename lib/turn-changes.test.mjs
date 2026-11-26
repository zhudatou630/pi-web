import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { turnScopedChanges } = await jiti.import("./turn-changes.ts");

const status = (filePath) => ({ filePath, status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M", additions: 1, deletions: 0 });

test("keeps only the uncommitted files the turn wrote, and counts the rest it wrote in cwd", () => {
  const files = [status("/repo/a.ts"), status("/repo/lib/b.ts"), status("/repo/c.ts")];
  const result = turnScopedChanges(files, ["/repo/lib/b.ts", "/repo/a.ts", "/repo/committed.ts", "/tmp/outside.txt", "/repo/a.ts"], "/repo/");
  assert.deepEqual(result.files.map((file) => file.filePath), ["/repo/lib/b.ts", "/repo/a.ts"]);
  assert.equal(result.omitted, 1);
});

test("matches Windows paths whatever their slashes", () => {
  const result = turnScopedChanges([status("C:/repo/a.ts")], ["C:\\repo\\a.ts"], "C:\\repo");
  assert.equal(result.files.length, 1);
  assert.equal(result.omitted, 0);
});

test("a turn that wrote nothing lists nothing", () => {
  assert.deepEqual(turnScopedChanges([status("/repo/a.ts")], [], "/repo"), { files: [], omitted: 0 });
});
