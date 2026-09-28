import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-image-settings-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const { POST } = await jiti.import("./connections/route.ts");
const { GET: popupGET } = await jiti.import("../route.ts");
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const { executeImageGeneration } = await jiti.import("../../../../lib/image-generation-runtime.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function request(url, body, method = "PUT") {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  });
}

async function writeSettings(value) {
  await mkdir(join(testAgentDir, "images"), { recursive: true });
  await writeFile(join(testAgentDir, "images", "settings.json"), JSON.stringify(value));
}

test("settings route rejects enabling an unauthenticated connection", async () => {
  await writeSettings({
    enabled: true,
    connections: { "grok-imagine": { enabled: false } },
  });

  const response = await PUT(request("/api/image-generation/settings", {
    connections: { "grok-imagine": { enabled: true } },
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Image connection grok-imagine cannot be enabled without configured credentials",
  });
  const stored = JSON.parse(await readFile(join(testAgentDir, "images", "settings.json"), "utf8"));
  assert.equal(stored.connections["grok-imagine"].enabled, false);
});

test("settings route saves an enabled default and rejects a disabled one", async () => {
  await writeSettings({
    enabled: true,
    connections: { "grok-imagine": { enabled: true }, "banana-2": { enabled: true } },
  });
  const saved = await PUT(request("/api/image-generation/settings", { default: "banana-2" }));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).defaultConnection, "banana-2");
  const invalid = await PUT(request("/api/image-generation/settings", { default: "chatgpt-flare" }));
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(await readFile(join(testAgentDir, "images", "settings.json"), "utf8")).default, "banana-2");
});

test("connections route rejects providers that are not in models.json", async () => {
  const response = await POST(request("/api/image-generation/settings/connections", {
    label: "Unlisted",
    provider: "not-in-models-json",
    model: "gpt-image-2.5-flare",
  }, "POST"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "provider must reference a provider configured in models.json",
  });
});

test("settings route still reports disabled when settings are off", async () => {
  await writeSettings({ enabled: false });
  const response = await GET(new Request("http://localhost/api/image-generation/settings"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).enabled, false);
});

test("a project setting wins over the image default both ways, and a missing file keeps the global state", async (t) => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), "pi-web-image-project-")));
  const other = realpathSync(await mkdtemp(join(tmpdir(), "pi-web-image-other-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  t.after(() => rm(other, { recursive: true, force: true }));
  allowFileRoot(cwd);
  allowFileRoot(other);
  // Legacy images.json means "on"; switching one project off must not turn it off globally.
  await rm(join(testAgentDir, "images"), { recursive: true, force: true });
  await writeFile(join(testAgentDir, "images.json"), JSON.stringify({
    connections: { "grok-imagine": { provider: "xai", model: "grok-imagine-image-2.0" } },
  }));
  t.after(() => rm(join(testAgentDir, "images.json"), { force: true }));

  const response = await PUT(request("/api/image-generation/settings", { cwd, projectEnabled: false }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.enabled, true);
  assert.deepEqual(body.project, { root: cwd, enabled: false, overridden: true });

  const here = await (await GET(new Request(`http://localhost/api/image-generation/settings?cwd=${encodeURIComponent(cwd)}`))).json();
  const there = await (await GET(new Request(`http://localhost/api/image-generation/settings?cwd=${encodeURIComponent(other)}`))).json();
  assert.equal(here.project.enabled, false);
  assert.equal(there.project.enabled, true);
  // The composer button is hidden for this project.
  assert.deepEqual(await (await popupGET(new Request(`http://localhost/api/image-generation?cwd=${encodeURIComponent(cwd)}`))).json(), { available: false });
  // And the one execution path refuses it, for the model tool and the button alike.
  await assert.rejects(
    executeImageGeneration(testAgentDir, { prompt: "a cat" }, { cwd, sessionManager: { getBranch: () => [] }, modelRegistry: {} }),
    /disabled in this project/,
  );

  const restored = await (await PUT(request("/api/image-generation/settings", { cwd, projectEnabled: true }))).json();
  assert.deepEqual(restored.project, { root: cwd, enabled: true, overridden: false });
  assert.equal("projects" in JSON.parse(await readFile(join(testAgentDir, "images", "settings.json"), "utf8")), false);

  // With the default off, this project alone can switch generation on.
  await PUT(request("/api/image-generation/settings", { enabled: false }));
  const onlyHere = await (await PUT(request("/api/image-generation/settings", { cwd, projectEnabled: true }))).json();
  assert.equal(onlyHere.enabled, false);
  assert.deepEqual(onlyHere.project, { root: cwd, enabled: true, overridden: true });
  const elsewhere = await (await GET(new Request(`http://localhost/api/image-generation/settings?cwd=${encodeURIComponent(other)}`))).json();
  assert.equal(elsewhere.project.enabled, false);
  await assert.rejects(
    executeImageGeneration(testAgentDir, { prompt: "a cat" }, { cwd: other, sessionManager: { getBranch: () => [] }, modelRegistry: {} }),
    /disabled in this project/,
  );
});
