import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getRemovableSkillEntry, removeSkillEntry } = await jiti.import("./skill-delete.ts");

test("only entries directly inside auto-discovered skill roots are removable", () => {
  const agentDir = "/home/u/.pi/agent";
  const cwd = "/work/repo";
  const is = (filePath) => getRemovableSkillEntry(filePath, cwd, agentDir);
  assert.equal(is(`${agentDir}/skills/foo/SKILL.md`), `${agentDir}/skills/foo`);
  assert.equal(is(`${agentDir}/skills/bar.md`), `${agentDir}/skills/bar.md`);
  assert.equal(is(`${cwd}/.pi/skills/foo/SKILL.md`), `${cwd}/.pi/skills/foo`);
  assert.equal(is(`/work/.agents/skills/foo/SKILL.md`), `/work/.agents/skills/foo`);
  assert.equal(is(`${agentDir}/skills/group/foo/SKILL.md`), null);
  assert.equal(is(`${agentDir}/git/github.com/o/pkg/skills/foo/SKILL.md`), null);
  assert.equal(is(`/opt/shared/foo/SKILL.md`), null);
});

test("symlinked skills are unlinked without touching the shared target", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-delete-"));
  const shared = join(dir, "shared");
  mkdirSync(shared);
  writeFileSync(join(shared, "SKILL.md"), "x");
  const link = join(dir, "link");
  symlinkSync(shared, link);
  removeSkillEntry(link);
  assert.equal(existsSync(link), false);
  assert.equal(existsSync(join(shared, "SKILL.md")), true);

  removeSkillEntry(shared);
  assert.equal(existsSync(shared), false);
});
