import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, PUT } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const { resolveVisibleModels } = await jiti.import("../../../../lib/model-scope.ts");

// All settings, credentials and trust records belong to this fixture.
test("clearing project rules keeps an unrestricted override; clearing global rules removes the key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-scope-layers-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(join(cwd, ".pi"), { recursive: true })]);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__piModelsConfigReadServices;
    await rm(root, { recursive: true, force: true });
  });
  allowFileRoot(cwd);
  new ProjectTrustStore(agentDir).set(cwd, true);
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  await writeFile(globalPath, JSON.stringify({ enabledModels: ["p/one"], defaultThinkingLevel: "low" }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { p: {
    api: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: "fixture",
    models: [{ id: "one" }, { id: "two" }],
  } } }));
  const available = ["one", "two"].map(id => ({ provider: "p", id, name: id }));
  const refs = state => state.visible.filter(model => model.provider === "p").map(model => model.id);
  const get = () => GET(new Request(`http://localhost/api/models-config/picker?cwd=${encodeURIComponent(cwd)}`));
  const clear = () => PUT(new Request("http://localhost/api/models-config/picker", {
    method: "PUT", headers: { Host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, patterns: [] }),
  }));

  // Verify the SDK contract, independently of the route's response document.
  await writeFile(projectPath, JSON.stringify({ enabledModels: [] }));
  let settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  assert.deepEqual(settings.getEnabledModels(), []);
  assert.equal((await resolveVisibleModels({ getAvailable: async () => available }, settings.getEnabledModels())).visible.length, 2);

  await writeFile(projectPath, JSON.stringify({ enabledModels: ["gone/**"], defaultThinkingLevel: "high" }));
  assert.deepEqual(refs(await (await get()).json()), ["one", "two"]);
  let response = await clear();
  assert.equal(response.status, 200);
  let state = await response.json();
  assert.equal(state.source, "project");
  assert.deepEqual(state.patterns, []);
  assert.deepEqual(refs(state), ["one", "two"]);
  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), { enabledModels: [], defaultThinkingLevel: "high" });
  assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")).enabledModels, ["p/one"]);
  settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  assert.deepEqual(settings.getEnabledModels(), []);
  assert.deepEqual(refs(await (await clear()).json()), ["one", "two"], "repeated clear keeps the project override");

  // Deleting the override is intentionally different from clearing its rules.
  await writeFile(projectPath, "{}");
  assert.deepEqual(SettingsManager.create(cwd, agentDir).getEnabledModels(), ["p/one"]);
  assert.deepEqual(refs(await (await get()).json()), ["one"]);
  await writeFile(globalPath, JSON.stringify({ enabledModels: ["gone/**"], defaultThinkingLevel: "low" }));
  assert.deepEqual(refs(await (await get()).json()), ["one", "two"]);
  response = await clear();
  assert.equal(response.status, 200);
  state = await response.json();
  assert.equal(state.source, "none");
  assert.deepEqual(refs(state), ["one", "two"]);
  assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), { defaultThinkingLevel: "low" });
});
