import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  isSubagentsEnabledForProject,
  readSubagentSettings,
  subagentProjectState,
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

test("a project setting wins over the global default in both directions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  const stored = async () => JSON.parse(await readFile(settingsPath, "utf8"));

  // Global on, one project off.
  writeProjectSubagentsEnabled("/chat", false, settingsPath);
  assert.deepEqual((await stored()).projects, { "/chat": false });
  assert.deepEqual(subagentProjectState("/chat", settingsPath), { root: "/chat", enabled: false, overridden: true });
  assert.equal(isSubagentsEnabledForProject("/code", settingsPath), true);

  // Global off: projects without a setting follow it, and one can still be switched on.
  writeBuiltInSubagentsEnabled(false, settingsPath);
  assert.equal(isSubagentsEnabledForProject("/code", settingsPath), false);
  writeProjectSubagentsEnabled("/lab", true, settingsPath);
  assert.deepEqual(subagentProjectState("/lab", settingsPath), { root: "/lab", enabled: true, overridden: true });
  // "/chat: off" now matches the default, so it no longer counts as a difference.
  assert.equal(subagentProjectState("/chat", settingsPath).overridden, false);

  // Switching a project to the default drops its entry.
  writeProjectSubagentsEnabled("/lab", false, settingsPath);
  writeProjectSubagentsEnabled("/chat", false, settingsPath);
  assert.equal("projects" in await stored(), false);
});

test("the older off-only list reads as project overrides and is rewritten on the next write", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ version: 1, builtInEnabled: true, disabledProjects: ["/old"] }));

  assert.equal(isSubagentsEnabledForProject("/old", settingsPath), false);
  writeProjectSubagentsEnabled("/new", false, settingsPath);
  const next = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(next.projects, { "/old": false, "/new": false });
  assert.equal("disabledProjects" in next, false);
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
