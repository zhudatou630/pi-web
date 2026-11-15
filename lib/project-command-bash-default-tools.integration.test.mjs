import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { createProjectCommandBashExtension, createProjectCommandPowerShellExtension } = await createJiti(import.meta.url).import("./project-command-env.ts");

// Pi Web's host bash is an extension tool; it must follow defaultTools like the built-in, also after reload (#1235 upstream).
async function activeToolsAfterReload(t, defaultTools) {
  const dir = await mkdtemp(join(tmpdir(), "host-bash-default-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory(defaultTools === undefined ? {} : { defaultTools });
  const hostBash = createProjectCommandBashExtension({ cwd: dir, settings: settingsManager });
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: dir, modelRuntime, settingsManager,
    resourceLoaderOptions: {
      extensionFactories: [hostBash, createProjectCommandPowerShellExtension(dir)],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    },
  });
  const { session } = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.inMemory(dir), model: faux.getModel("faux-model"),
  });
  t.after(() => session.dispose());
  const initial = session.getActiveToolNames();
  await session.reload();
  return { initial, reloaded: session.getActiveToolNames() };
}

test("host PowerShell follows explicit selection and preserves tool order after reload", async (t) => {
  const expected = ["read", "powershell", "edit"];
  const { initial, reloaded } = await activeToolsAfterReload(t, expected);
  assert.deepEqual(initial, expected);
  assert.deepEqual(reloaded, expected);
});

test("host bash stays off when defaultTools leaves it out, also after reload", async (t) => {
  for (const defaultTools of [["read"], ["-bash"]]) {
    const { initial, reloaded } = await activeToolsAfterReload(t, defaultTools);
    assert.ok(!initial.includes("bash"), `${defaultTools}: ${initial}`);
    assert.ok(!reloaded.includes("bash"), `${defaultTools} after reload: ${reloaded}`);
  }
});

test("host bash is on when defaultTools names it or is unset", async (t) => {
  for (const defaultTools of [undefined, ["read", "bash"]]) {
    const { initial, reloaded } = await activeToolsAfterReload(t, defaultTools);
    assert.ok(!reloaded.includes("powershell"));
    assert.ok(!initial.includes("powershell"));
    assert.ok(initial.includes("bash"), `${defaultTools}: ${initial}`);
    assert.ok(reloaded.includes("bash"), `${defaultTools} after reload: ${reloaded}`);
  }
});
