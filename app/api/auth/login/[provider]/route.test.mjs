import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(join(tmpdir(), "pi-login-route-"));
const stub = join(root, "services.cjs");
await writeFile(stub, `module.exports = {
  resolveOptionalCwd: async () => ({ cwd: 'fixture' }),
  createModelsConfigServices: async () => globalThis.__loginRouteServices,
};`);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const source = (await readFile(new URL("./route.ts", import.meta.url), "utf8"))
  .replace('"@/lib/model-config-services"', JSON.stringify(stub));
const { GET } = createJiti(import.meta.url, {
  tsconfigPaths: true,
}).evalModule(source, { filename: new URL("./route.ts", import.meta.url).pathname });
after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  delete globalThis.__loginRouteServices;
  delete globalThis.__piLoginCallbacks;
  await rm(root, { recursive: true, force: true });
});
const context = { params: Promise.resolve({ provider: "fixture" }) };
function services(settingsManager, login) {
  globalThis.__loginRouteServices = {
    settingsManager,
    modelRuntime: { getProvider: () => ({ auth: { oauth: {} } }), login },
  };
}
const request = (signal) => new Request("http://localhost/api/auth/login/fixture", { signal });

test("OAuth gets a stable global device ID flushed before login, ignoring the project ID", async () => {
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ deviceId: "project-id" }));
  let first;
  let notify;
  for (let i = 0; i < 2; i++) {
    services(SettingsManager.create(cwd, agentDir), async (_id, _type, interaction, options) => {
      notify = interaction.notify;
      const id = options.getDeviceId();
      assert.match(id, /^[0-9a-f-]{36}$/);
      assert.equal(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).deviceId, id);
      if (first) assert.equal(id, first);
      first = id;
      for (let n = 0; n < 3; n++) notify({ type: "progress", message: String(n) });
    });
    const text = await (await GET(request(), context)).text();
    assert.match(text, /"type":"success"/);
    assert.equal((text.match(/"type":"progress"/g) ?? []).length, 3);
    assert.doesNotThrow(() => notify({ type: "progress", message: "late" }));
    assert.doesNotThrow(() => notify({ type: "auth_url", url: "https://example.test" }));
    assert.equal(globalThis.__piLoginCallbacks.size, 0);
  }
});

test("settings write and read errors are streamed without starting login", async () => {
  for (const storage of [
    { withLock() { throw new Error("cannot read settings"); } },
    { withLock(_scope, fn) { if (fn(undefined) !== undefined) throw new Error("cannot write settings"); } },
  ]) {
    services(SettingsManager.fromStorage(storage), () => assert.fail("must not log in"));
    const text = await (await GET(request(), context)).text();
    assert.match(text, /"type":"error"/);
    assert.match(text, /cannot (read|write) settings/);
    assert.doesNotMatch(text, /"type":"success"/);
  }
});

test("disconnect cancels pending input, cleans tokens and tolerates late callbacks", async () => {
  let interaction;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  services(SettingsManager.inMemory(), async (_id, _type, value) => {
    interaction = value;
    const pending = value.prompt({ type: "manual_code", message: "Code" });
    started();
    await pending;
  });
  const abort = new AbortController();
  const response = await GET(request(abort.signal), context);
  await ready;
  assert.equal(globalThis.__piLoginCallbacks.size, 1);
  abort.abort();
  assert.match(await response.text(), /"type":"cancelled"/);
  assert.equal(interaction.signal.aborted, true);
  assert.equal(globalThis.__piLoginCallbacks.size, 0);
  assert.doesNotThrow(() => interaction.notify({ type: "progress", message: "late" }));
  await assert.rejects(interaction.prompt({ type: "manual_code", message: "late" }), /cancelled/);
});

test("reader cancellation still aborts login", async () => {
  let interaction;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  services(SettingsManager.inMemory(), async (_id, _type, value) => {
    interaction = value;
    entered();
    await new Promise((_, reject) => value.signal.addEventListener("abort", () => reject(new Error("Login cancelled"))));
  });
  const response = await GET(request(), context);
  await ready;
  await response.body.cancel();
  assert.equal(interaction.signal.aborted, true);
  assert.doesNotThrow(() => interaction.notify({ type: "progress", message: "late" }));
});
