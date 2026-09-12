import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-skills-route-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PATCH } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function patchRequest(body) {
  return new Request("http://localhost/api/skills", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("PATCH /api/skills authorizes by loaded-skill membership, not extra roots", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /loadSkillsWithInstallInfo\(cwd\)/);
  assert.match(source, /skill\.filePath === filePath/);
  assert.doesNotMatch(source, /globalSkillsDir|getAgentDir\(/);
});

test("PATCH /api/skills requires cwd", async () => {
  const response = await PATCH(patchRequest({
    filePath: "/tmp/SKILL.md",
    disableModelInvocation: true,
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "cwd required" });
});

test("PATCH /api/skills toggles a loaded skill whose realpath is outside allowed roots", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-skills-route-cwd-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const realDir = await mkdtemp(join(tmpdir(), "pi-web-skills-route-real-"));
  t.after(() => rm(realDir, { recursive: true, force: true }));
  await writeFile(
    join(realDir, "SKILL.md"),
    "---\nname: linked-skill\ndescription: Demo skill\n---\nBody.\n",
  );

  const skillsDir = join(testAgentDir, "skills");
  await mkdir(skillsDir, { recursive: true });
  await symlink(realDir, join(skillsDir, "linked-skill"));

  const listed = await GET(new Request(`http://localhost/api/skills?cwd=${encodeURIComponent(cwd)}`));
  assert.equal(listed.status, 200);
  const skill = (await listed.json()).skills.find((item) => item.name === "linked-skill");
  assert.ok(skill, "expected GET to list the symlinked skill");

  const outsider = join(cwd, "not-a-skill.md");
  await writeFile(outsider, "nope\n");
  const denied = await PATCH(patchRequest({
    cwd,
    filePath: outsider,
    disableModelInvocation: true,
  }));
  assert.equal(denied.status, 403);

  const toggled = await PATCH(patchRequest({
    cwd,
    filePath: skill.filePath,
    disableModelInvocation: true,
  }));
  assert.equal(toggled.status, 200);
  assert.deepEqual(await toggled.json(), { success: true });
  assert.match(await readFile(join(realDir, "SKILL.md"), "utf8"), /disable-model-invocation: true/);
});
