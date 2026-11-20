import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { createHostPackageManager } = await createJiti(import.meta.url).import("./host-package-manager.ts");

test("a plugin update looks versions up in pi's user npm prefix, not the selected project folder", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-host-packages-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.PI_OFFLINE; // would make pi skip the update altogether
  delete process.env.PI_OFFLINE;
  t.after(() => { if (previous !== undefined) process.env.PI_OFFLINE = previous; });

  const project = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(project);
  mkdirSync(join(agentDir, "npm", "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(agentDir, "npm", "node_modules", "pkg", "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
  // Stands in for npm: `view` records where it ran (where npm would read .npmrc) and reports no update.
  const npm = join(root, "npm.cjs");
  const viewCwd = join(root, "view-cwd");
  writeFileSync(npm, `if (process.argv.includes("view")) {
  require("fs").writeFileSync(${JSON.stringify(viewCwd)}, process.cwd());
  console.log(JSON.stringify("1.0.0"));
}
`);
  const update = async (create) => {
    rmSync(viewCwd, { force: true });
    const settingsManager = SettingsManager.inMemory({ packages: ["npm:pkg"], npmCommand: [process.execPath, npm] });
    await create({ cwd: project, agentDir, settingsManager }).update("npm:pkg");
    return readFileSync(viewCwd, "utf8");
  };

  assert.equal(await update((options) => new DefaultPackageManager(options)), project, "pi itself runs it in the project");
  assert.equal(await update(createHostPackageManager), join(agentDir, "npm"));
});

test("only npm version lookups move; git keeps its checkout, even when that is the project", (t) => {
  const calls = [];
  t.mock.method(DefaultPackageManager.prototype, "spawnCaptureCommand", (command, args, options) => calls.push([command, options.cwd]));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-host-packages-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const manager = createHostPackageManager({ cwd: "/plugin-checkout", agentDir, settingsManager: SettingsManager.inMemory() });
  manager.spawnCaptureCommand("git", ["rev-parse", "HEAD"], { cwd: "/plugin-checkout" });
  manager.spawnCaptureCommand("bunx", ["npm", "view", "pkg@^1", "version", "--json"], { cwd: "/plugin-checkout", timeoutMs: 1 });
  assert.deepEqual(calls, [["git", "/plugin-checkout"], ["bunx", agentDir]]);
});
