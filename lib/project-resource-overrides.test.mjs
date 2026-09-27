import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resolveScopedResources, setProjectOverrides } = await jiti.import("./project-resource-overrides.ts");

function skill(dir, name) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n`);
  return join(dir, name, "SKILL.md");
}

function setup(globalPackage) {
  const root = mkdtempSync(join(tmpdir(), "pi-overrides-"));
  const agentDir = join(root, "agent");
  const pkgDir = join(root, "pkg");
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const a = skill(join(pkgDir, "skills"), "pkg-a");
  const b = skill(join(pkgDir, "skills"), "pkg-b");
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "pkg", pi: { skills: ["./skills"] } }));
  const solo = skill(join(agentDir, "skills"), "solo");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [globalPackage(pkgDir)] }));
  return { agentDir, cwd, a, b, solo };
}

const projectSettings = (cwd) => JSON.parse(readFileSync(join(cwd, ".pi/settings.json"), "utf8"));

async function state(cwd, agentDir, path) {
  const { resources } = await resolveScopedResources(cwd, agentDir);
  const found = resources.find((r) => r.type === "skills" && r.path === path);
  return found && { enabled: found.enabled, override: found.override, globalEnabled: found.globalEnabled };
}

test("package resource: turning off writes an autoload:false delta; turning back on drops it", async () => {
  const { agentDir, cwd, a, b } = setup((dir) => dir);
  await setProjectOverrides(cwd, agentDir, [{ type: "skills", path: a }], false);

  const [entry] = projectSettings(cwd).packages;
  assert.equal(entry.autoload, false);
  assert.deepEqual(entry.skills, ["-skills/pkg-a/SKILL.md"]);
  assert.deepEqual(await state(cwd, agentDir, a), { enabled: false, override: "unload", globalEnabled: true });
  assert.deepEqual(await state(cwd, agentDir, b), { enabled: true, override: "inherit", globalEnabled: true });

  await setProjectOverrides(cwd, agentDir, [{ type: "skills", path: a }], true);
  assert.deepEqual(projectSettings(cwd).packages, []);
  assert.deepEqual(await state(cwd, agentDir, a), { enabled: true, override: "inherit", globalEnabled: true });
});

test("package disabled globally can be loaded in one project only", async () => {
  const { agentDir, cwd, a, b } = setup((dir) => ({ source: dir, skills: [] }));
  assert.deepEqual(await state(cwd, agentDir, b), { enabled: false, override: "inherit", globalEnabled: false });

  await setProjectOverrides(cwd, agentDir, [{ type: "skills", path: b }], true);
  assert.deepEqual(await state(cwd, agentDir, b), { enabled: true, override: "load", globalEnabled: false });
  assert.equal((await state(cwd, agentDir, a)).enabled, false);

  await setProjectOverrides(cwd, agentDir, [{ type: "skills", path: b }], false);
  assert.deepEqual(projectSettings(cwd).packages, []);
});

test("refuses to write over an unreadable project settings file", async () => {
  const { agentDir, cwd, a } = setup((dir) => dir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi/settings.json"), "{ broken");
  new ProjectTrustStore(agentDir).set(cwd, true);
  await assert.rejects(setProjectOverrides(cwd, agentDir, [{ type: "skills", path: a }], false), /Cannot read/);
  assert.equal(readFileSync(join(cwd, ".pi/settings.json"), "utf8"), "{ broken");
});

test("top-level skill: project unload uses absolute path patterns", async () => {
  const { agentDir, cwd, solo } = setup((dir) => dir);
  await setProjectOverrides(cwd, agentDir, [{ type: "skills", path: solo }], false);

  assert.deepEqual(projectSettings(cwd).skills, [solo, `-${solo}`]);
  assert.deepEqual(await state(cwd, agentDir, solo), { enabled: false, override: "unload", globalEnabled: true });

  await setProjectOverrides(cwd, agentDir, [{ type: "skills", path: solo }], true);
  assert.deepEqual(projectSettings(cwd).skills, []);
  assert.equal((await state(cwd, agentDir, solo)).enabled, true);
});

test("hand-written project entries are read-only", async () => {
  const { agentDir, cwd, a } = setup((dir) => dir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({
    packages: [{ source: "../../pkg", autoload: false, skills: ["!**"] }],
  }));
  new ProjectTrustStore(agentDir).set(cwd, true);
  const { resources } = await resolveScopedResources(cwd, agentDir);
  const found = resources.find((r) => r.path === a);
  assert.equal(found.enabled, false);
  assert.equal(found.editable, false);
  await assert.rejects(setProjectOverrides(cwd, agentDir, [{ type: "skills", path: a }], true), /hand-written/);
});
