import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { withCodemode, readCodemodeState, writeGlobalCodemode, writeProjectCodemode } = await jiti.import("./codemode-settings.ts");
const { trustProject } = await jiti.import("./project-trust.ts");

/** What pi resolves for these two layers, from real files. */
async function piTools(root, global, project) {
  const agentDir = await mkdtemp(join(root, "agent-"));
  const cwd = await mkdtemp(join(root, "cwd-"));
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(global === undefined ? {} : { defaultTools: global }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(project === undefined ? {} : { defaultTools: project }));
  return SettingsManager.create(cwd, agentDir, { projectTrusted: true }).getDefaultTools() ?? ["read", "bash", "edit", "write"];
}

test("withCodemode changes only codemode, as pi resolves both layers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-codemode-table-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lists = [undefined, [], ["+codemode"], ["-write", "+codemode"], ["read", "bash"], ["read", "codemode"], ["codemode"], ["codemode", "-write"], ["-codemode"]];
  for (const global of lists) {
    for (const project of [undefined, ...lists]) {
      for (const enabled of [true, false]) {
        const label = JSON.stringify({ global, project, enabled });
        const before = await piTools(root, global, project);
        const expected = [...before.filter((name) => name !== "codemode"), ...(enabled ? ["codemode"] : [])].sort();
        let next;
        try {
          next = withCodemode(project, global, enabled);
        } catch (error) {
          // Only an emptied replacing project list over an inherited one is refused.
          assert.equal(expected.length, 0, label);
          assert.match(error.message, /edit \.pi\/settings\.json/, label);
          continue;
        }
        assert.deepEqual((await piTools(root, global, next)).sort(), expected, label);
        // The global layer alone, over pi's defaults.
        const globalNext = withCodemode(global, undefined, enabled);
        const globalBefore = await piTools(root, global, undefined);
        assert.deepEqual((await piTools(root, globalNext, undefined)).sort(),
          [...globalBefore.filter((name) => name !== "codemode"), ...(enabled ? ["codemode"] : [])].sort(), label);
      }
    }
  }
  // Matching the inherited state drops the project's own entry; an emptied +/- list is removed.
  assert.equal(withCodemode(["-codemode"], ["+codemode"], true), undefined);
  assert.equal(withCodemode(["+codemode"], undefined, false), undefined);
  assert.deepEqual(withCodemode(["codemode", "-write"], undefined, false), []);
});

test("a BOM-prefixed settings file reads like pi reads it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-codemode-bom-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "settings.json"), `\uFEFF${JSON.stringify({ defaultTools: ["+codemode"] })}`);
  assert.deepEqual(readCodemodeState(root), { enabled: true });
  await writeGlobalCodemode(root, false);
  assert.deepEqual(JSON.parse(await readFile(join(root, "settings.json"), "utf8")), {});
});

test("written settings resolve in pi as the switches show", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-codemode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "keep" }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["-x"] }));
  trustProject(cwd, agentDir);
  const piTools = () => SettingsManager.create(cwd, agentDir, { projectTrusted: true }).getDefaultTools() ?? ["read", "bash", "edit", "write"];

  await writeGlobalCodemode(agentDir, true);
  assert.deepEqual(readCodemodeState(agentDir, cwd), { enabled: true, project: { root: cwd, enabled: true, overridden: false } });
  assert.ok(piTools().includes("codemode"));

  await writeProjectCodemode(cwd, agentDir, false);
  assert.deepEqual(readCodemodeState(agentDir, cwd).project, { root: cwd, enabled: false, overridden: true });
  assert.ok(!piTools().includes("codemode"));
  assert.deepEqual(piTools(), ["read", "bash", "edit", "write"]);

  await writeProjectCodemode(cwd, agentDir, true);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8")), { skills: ["-x"] });

  await writeGlobalCodemode(agentDir, false);
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), { defaultModel: "keep" });
  assert.deepEqual(readCodemodeState(agentDir, cwd), { enabled: false, project: { root: cwd, enabled: false, overridden: false } });
});

test("project writes need a trusted project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-codemode-untrusted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const original = JSON.stringify({ skills: ["-x"] });
  await writeFile(join(cwd, ".pi", "settings.json"), original);
  await assert.rejects(writeProjectCodemode(cwd, agentDir, true), /trusted/);
  assert.equal(await readFile(join(cwd, ".pi", "settings.json"), "utf8"), original);
});
