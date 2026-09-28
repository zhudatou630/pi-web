import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  isProjectSubagentsDisabled,
  isSubagentsEnabledForProject,
  readSubagentSettings,
  writeBuiltInSubagentsEnabled,
  writeProjectSubagentsEnabled,
  writeSubagentMaxConcurrent,
} = await createJiti(import.meta.url).import("./subagent-settings.ts");

test("subagent settings default the built-in extension to enabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: true, maxConcurrent: 10 });
  assert.equal(isSubagentsEnabledForProject("/p", settingsPath), true);
});

test("subagent settings persist both states and preserve unrelated fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: true, maxConcurrent: 10 });
  assert.equal(isSubagentsEnabledForProject("/p", settingsPath), true);
  const first = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(first, { version: 1, builtInEnabled: true });

  await writeFile(settingsPath, JSON.stringify({ ...first, futureSetting: 3 }));
  writeBuiltInSubagentsEnabled(false, settingsPath);
  const second = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(second, { version: 1, builtInEnabled: false, futureSetting: 3 });
});

test("a project switch turns sub-agents off only for that project, under the global switch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");

  writeProjectSubagentsEnabled("/chat", false, settingsPath);
  writeProjectSubagentsEnabled("/chat", false, settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).disabledProjects, ["/chat"]);
  assert.equal(isProjectSubagentsDisabled("/chat", settingsPath), true);
  assert.equal(isSubagentsEnabledForProject("/chat", settingsPath), false);
  assert.equal(isSubagentsEnabledForProject("/code", settingsPath), true);

  writeBuiltInSubagentsEnabled(false, settingsPath);
  assert.equal(isSubagentsEnabledForProject("/code", settingsPath), false);
  writeBuiltInSubagentsEnabled(true, settingsPath);

  writeProjectSubagentsEnabled("/chat", true, settingsPath);
  assert.equal(isSubagentsEnabledForProject("/chat", settingsPath), true);
  assert.equal("disabledProjects" in JSON.parse(await readFile(settingsPath, "utf8")), false);
});

test("damaged settings fail closed and are not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, "{");

  assert.equal(isSubagentsEnabledForProject("/p", settingsPath), false);
  assert.throws(() => readSubagentSettings(settingsPath));
  assert.throws(() => writeBuiltInSubagentsEnabled(true, settingsPath));
  assert.equal(await readFile(settingsPath, "utf8"), "{");
});
