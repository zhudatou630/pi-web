import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = fs.mkdtempSync(join(tmpdir(), "pi-web-config-links-"));
const savedEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = root;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { writeModelsConfig } = await jiti.import("./models-config-store.ts");
const { updateSidebarState, removeSidebarSessions } = await jiti.import("./sidebar-state.ts");
const { writeBuiltInSubagentsEnabled, writeProjectSubagentsEnabled, writeSubagentMaxConcurrent } = await jiti.import("./subagent-settings.ts");
const { saveSubagentProfile, importAgentProfiles, setSubagentProfileEnabled } = await jiti.import("./subagents.ts");
const { getImageSettingsPath, writeImageGenerationSettings, writeImageProjectEnabled } = await jiti.import("./image-generation-config.ts");
const { writePowerShellToolEnabled } = await jiti.import("./powershell-settings.ts");
test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const profile = {
  name: "linked", displayName: "Linked", description: "Linked agent", systemPrompt: "Updated prompt",
  tools: ["read"], loadSkills: false, loadExtensions: false, enabled: true,
  inheritContext: false, runInBackground: false,
};
const cases = [
  ["models.json", (dir) => join(dir, "models.json"), "{}", (file) => writeModelsConfig({ providers: { synthetic: { models: [{ id: "new" }] } } }, file)],
  ["sidebar update", (dir) => join(dir, "pi-web", "sidebar-state.json"), '{"version":1,"pinned":[],"archived":{}}', (file) => updateSidebarState(["session"], { pinned: true }, file)],
  ["sidebar cleanup", (dir) => join(dir, "pi-web", "sidebar-state.json"), '{"version":1,"pinned":["session"],"archived":{}}', (file) => removeSidebarSessions(["session"], file)],
  ["subagent global toggle", (dir) => join(dir, "agents", "settings.json"), "{}", (file) => writeBuiltInSubagentsEnabled(false, file)],
  ["subagent project toggle in user settings", (dir) => join(dir, "agents", "settings.json"), "{}", (file) => writeProjectSubagentsEnabled("/project", false, file)],
  ["subagent concurrency", (dir) => join(dir, "agents", "settings.json"), "{}", (file) => writeSubagentMaxConcurrent(3, file)],
  ["global agent profile", (dir) => join(dir, "agents", "linked.md"), "---\ndescription: Original\n---\nOriginal prompt\n", (_file, dir) => saveSubagentProfile(dir, "global", profile)],
  ["image settings", getImageSettingsPath, "{}", (_file, dir) => writeImageGenerationSettings({ enabled: false }, dir)],
  ["image project toggle in user settings", getImageSettingsPath, '{"enabled":true}', (_file, dir) => writeImageProjectEnabled(dir, "/project", false)],
];

function linkedFile(t, getPath, initial, dangling = false) {
  const dir = fs.mkdtempSync(join(root, "agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  const file = getPath(dir);
  const targetDir = fs.mkdtempSync(join(root, "dotfiles-"));
  const target = join(targetDir, "target");
  fs.mkdirSync(dirname(file), { recursive: true });
  if (!dangling) fs.writeFileSync(target, initial, { mode: 0o600 });
  // A relative link into another directory exercises where the atomic temp file belongs.
  try { fs.symlinkSync(relative(dirname(file), target), file); }
  catch (error) {
    if (error.code === "EPERM") { t.skip("symlinks unavailable"); return; }
    throw error;
  }
  return { dir, file, target, targetDir };
}

for (const [name, getPath, initial, write] of cases) {
  test(`${name}: saving preserves the link and updates its target atomically`, async (t) => {
    const f = linkedFile(t, getPath, initial);
    if (!f) return;
    const before = fs.statSync(f.target).ino;
    await write(f.file, f.dir);
    assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
    assert.notEqual(fs.readFileSync(f.target, "utf8"), initial);
    assert.equal(fs.readFileSync(f.file, "utf8"), fs.readFileSync(f.target, "utf8"));
    assert.deepEqual(fs.readdirSync(f.targetDir), ["target"], "no temp files left beside the real target");
    assert.equal(fs.existsSync(`${f.file}.lock`), false, "existing locks are released");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(f.target).mode & 0o777, 0o600);
      assert.notEqual(fs.statSync(f.target).ino, before, "replace the target atomically, not in place");
    }
  });

  test(`${name}: a dangling link is never replaced`, async (t) => {
    const f = linkedFile(t, getPath, initial, true);
    if (!f) return;
    // Cleanup of a missing sidebar state is a no-op, not a write attempt.
    if (name === "sidebar cleanup") await write(f.file, f.dir);
    else await assert.rejects(async () => write(f.file, f.dir), /dangling symlink/i);
    assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(fs.existsSync(`${f.file}.lock`), false);
  });
}

test("SDK settings.json writes already preserve symlinks", async (t) => {
  const f = linkedFile(t, (dir) => join(dir, "settings.json"), "{}");
  if (!f) return;
  const settings = SettingsManager.create(f.dir, f.dir, { projectTrusted: false });
  settings.setDefaultThinkingLevel("high");
  await settings.flush();
  assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(f.target, "utf8")).defaultThinkingLevel, "high");
});

test("PowerShell settings.json writes already preserve symlinks", async (t) => {
  const f = linkedFile(t, (dir) => join(dir, "settings.json"), "{}");
  if (!f) return;
  await writePowerShellToolEnabled(true, f.file, "win32");
  assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
  assert.ok(JSON.parse(fs.readFileSync(f.target, "utf8")).defaultTools.includes("powershell"));
});

test("project agent writes do not follow a file link outside the project", (t) => {
  const f = linkedFile(t, (dir) => join(dir, ".pi", "agents", "linked.md"), "Original prompt");
  if (!f) return;
  // A new temporary directory is auto-trustable; no real trust database is involved.
  saveSubagentProfile(f.dir, "project", profile);
  assert.equal(fs.readFileSync(f.target, "utf8"), "Original prompt");
  assert.equal(fs.lstatSync(f.file).isSymbolicLink(), false);
});

test("global profile import refuses a dangling destination link instead of replacing it", (t) => {
  const f = linkedFile(t, (dir) => join(dir, "agents", "linked.md"), "", true);
  if (!f) return;
  const source = join(f.dir, "source");
  fs.mkdirSync(join(source, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(join(source, ".pi", "agents", "linked.md"), "---\ndescription: Imported\n---\nPrompt\n");
  const result = importAgentProfiles(f.dir, source, "global", ["linked.md"]);
  assert.deepEqual(result.imported, []);
  assert.match(result.skipped[0].reason, /dangling symlink/i);
  assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
});

test("global disable stub refuses a dangling destination link", (t) => {
  const f = linkedFile(t, (dir) => join(dir, "agents", "explore.md"), "", true);
  if (!f) return;
  assert.throws(() => setSubagentProfileEnabled(f.dir, "explore", false), /dangling symlink/i);
  assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
});

test("a linked global profile is read as itself, so disabling keeps its definition", (t) => {
  const f = linkedFile(t, (dir) => join(dir, "agents", "explore.md"), "---\ndescription: My explore\nisolation: worktree\n---\nCustom prompt\n");
  if (!f) return;
  setSubagentProfileEnabled(f.dir, "explore", false);
  const saved = fs.readFileSync(f.target, "utf8");
  assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
  assert.match(saved, /enabled: false/);
  assert.match(saved, /description: My explore/);
  assert.match(saved, /isolation: worktree/);
  assert.match(saved, /Custom prompt/);
});
