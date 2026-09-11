import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).enabled, false);
});
