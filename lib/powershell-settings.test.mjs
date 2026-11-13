import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  builtinToolsOf,
  withBuiltinTools,
  readToolSettings,
  writeBuiltinTools,
  isPowerShellToolEnabled,
  readPowerShellToolEnabled,
  resolveShellTools,
  writePowerShellToolEnabled,
} = await createJiti(import.meta.url).import("./powershell-settings.ts");

test("built-in edits agree with SDK resolution, preserving non-built-ins and carried order", async () => {
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const names = ["read", "grep", "find", "ls", "edit", "write", "bash"];
  for (const entries of [undefined, [], ["+codemode", "-edit"], ["grep", "extension", "read", "+codemode", "-write"], ["read", "extension", "-read", "+read", "+codemode"], ["-bash", "+powershell", "+codemode"]]) {
    for (const platform of ["linux", "win32"]) {
      for (let mask = 0; mask < 128; mask++) {
        const selected = names.filter((_, index) => mask & (1 << index));
        const next = withBuiltinTools(entries, selected, platform);
        const resolved = SettingsManager.inMemory(next === undefined ? {} : { defaultTools: next }).getDefaultTools() ?? ["read", "bash", "edit", "write"];
        assert.deepEqual(builtinToolsOf(resolved, platform).sort(), [...selected].sort(), JSON.stringify({ entries, selected, next, platform }));
        const previous = SettingsManager.inMemory(entries === undefined ? {} : { defaultTools: entries }).getDefaultTools() ?? ["read", "bash", "edit", "write"];
        const managed = new Set([...names, ...(platform === "win32" ? ["powershell"] : [])]);
        assert.deepEqual(resolved.filter(name => !managed.has(name)), previous.filter(name => !managed.has(name)));
        const carried = previous.filter(name => resolved.includes(name));
        assert.deepEqual(resolved.filter(name => carried.includes(name)), carried, "carried tools must not be regrouped");
      }
    }
  }
});

test("built-in settings use the existing lock and preserve unrelated settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-builtins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  await writeFile(path, JSON.stringify({ defaultTools: ["+codemode"], keep: true }));
  await writeBuiltinTools(["read", "grep"], path);
  assert.deepEqual((await readToolSettings(path)).builtinTools, ["read", "grep"]);
  const settings = JSON.parse(await readFile(path, "utf8"));
  assert.equal(settings.keep, true);
  assert.ok(settings.defaultTools.includes("+codemode"));
  await writeFile(path, "invalid");
  await assert.rejects(writeBuiltinTools(["read"], path));
  assert.equal(await readFile(path, "utf8"), "invalid");
});

test("malformed settings name their path on read and write without changing the file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-powershell-parse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  const original = '{ "defaultModel": "keep", broken';
  await writeFile(settingsPath, original);
  for (const action of [
    () => readPowerShellToolEnabled(settingsPath, "win32"),
    () => writePowerShellToolEnabled(true, settingsPath, "win32"),
  ]) {
    await assert.rejects(action(), (error) => (
      error instanceof SyntaxError && error.message.startsWith(`${settingsPath}: `)
    ));
    assert.equal(await readFile(settingsPath, "utf8"), original);
    assert.deepEqual(await readdir(root), ["settings.json"]);
  }
  await writeFile(settingsPath, "[]");
  await assert.rejects(readPowerShellToolEnabled(settingsPath, "win32"), {
    name: "Error", message: "Invalid settings.json: expected an object",
  });
  assert.equal(await readFile(settingsPath, "utf8"), "[]");
});

test("PowerShell is opt-in on Windows and never selected on other platforms", () => {
  assert.equal(isPowerShellToolEnabled(undefined, "win32"), false);
  assert.equal(isPowerShellToolEnabled(["read", "powershell"], "win32"), true);
  assert.equal(isPowerShellToolEnabled(["read", "bash", "powershell"], "win32"), false);
  assert.equal(isPowerShellToolEnabled(["read", "powershell"], "darwin"), false);
  assert.deepEqual(
    resolveShellTools(["read", "bash", "edit"], ["read", "powershell"], "win32"),
    ["read", "powershell", "edit"],
  );
  assert.deepEqual(
    resolveShellTools(["read", "bash", "edit"], ["read", "powershell"], "darwin"),
    ["read", "bash", "edit"],
  );
});

test("the setting preserves unrelated config and switches defaultTools both ways", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-powershell-"));
  const settingsPath = join(root, "settings.json");

  assert.equal(await readPowerShellToolEnabled(settingsPath, "win32"), false);
  await writePowerShellToolEnabled(true, settingsPath, "win32");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    defaultTools: ["read", "powershell", "edit", "write"],
  });

  const configured = JSON.parse(await readFile(settingsPath, "utf8"));
  configured.unrelated = { keep: true };
  await writeFile(settingsPath, JSON.stringify(configured));
  await writePowerShellToolEnabled(false, settingsPath, "win32");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    defaultTools: ["read", "bash", "edit", "write"],
    unrelated: { keep: true },
  });
});

test("enabling PowerShell adds it when a custom defaultTools list has no shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-powershell-custom-"));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ defaultTools: ["read", "grep"] }));

  await writePowerShellToolEnabled(true, settingsPath, "win32");
  assert.deepEqual(
    JSON.parse(await readFile(settingsPath, "utf8")).defaultTools,
    ["read", "grep", "powershell"],
  );
});

test("invalid defaultTools are rejected without overwriting the settings file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-powershell-invalid-"));
  const settingsPath = join(root, "settings.json");
  const original = JSON.stringify({ defaultTools: "bash", unrelated: true });
  await writeFile(settingsPath, original);

  await assert.rejects(
    writePowerShellToolEnabled(true, settingsPath, "win32"),
    /defaultTools must be an array of strings/,
  );
  assert.equal(await readFile(settingsPath, "utf8"), original);
});

test("a +/- defaultTools list stays a delta and resolves like pi's", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-powershell-"));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ defaultTools: ["+codemode"] }));

  assert.equal(await readPowerShellToolEnabled(settingsPath, "win32"), false);
  await writePowerShellToolEnabled(true, settingsPath, "win32");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).defaultTools, ["+codemode", "-bash", "+powershell"]);
  assert.equal(await readPowerShellToolEnabled(settingsPath, "win32"), true);
  await writePowerShellToolEnabled(false, settingsPath, "win32");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).defaultTools, ["+codemode"]);
});
