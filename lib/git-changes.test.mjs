import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

async function loadSubject() {
  return import("./git-status.ts");
}

async function loadChanges() {
  return createJiti(import.meta.url).import("./git-changes.ts");
}

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

test("spells git paths using the explorer cwd so tree badges match", async () => {
  const { toCwdSpelledGitPath } = await loadChanges();
  assert.equal(toCwdSpelledGitPath("/repo", "/repo", "app/foo.ts"), "/repo/app/foo.ts");
  assert.equal(toCwdSpelledGitPath("/repo/", "/repo", "app/foo.ts"), "/repo/app/foo.ts");
  assert.equal(toCwdSpelledGitPath("/repo/app", "/repo", "app/foo.ts"), "/repo/app/foo.ts");
  assert.equal(toCwdSpelledGitPath("/repo/app", "/repo", "lib/bar.ts"), null);
});

test("maps git paths through a symlink cwd onto that cwd's spelling", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink cwd mapping is exercised on POSIX");
    return;
  }
  const { toCwdSpelledGitPath } = await loadChanges();
  const root = mkdtempSync(path.join(tmpdir(), "pi-git-"));
  try {
    const realRepo = path.join(root, "real");
    const linkRepo = path.join(root, "link");
    mkdirSync(path.join(realRepo, "app"), { recursive: true });
    symlinkSync(realRepo, linkRepo);
    assert.equal(toCwdSpelledGitPath(linkRepo, realRepo, "app/foo.ts"), `${linkRepo}/app/foo.ts`);
    assert.equal(
      toCwdSpelledGitPath(path.join(linkRepo, "app"), realRepo, "app/foo.ts"),
      `${linkRepo}/app/foo.ts`,
    );
    assert.equal(toCwdSpelledGitPath(path.join(linkRepo, "app"), realRepo, "lib/bar.ts"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
