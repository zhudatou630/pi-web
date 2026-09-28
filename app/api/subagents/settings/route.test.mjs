import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function request(body, contentType = "application/json") {
  return new Request("http://localhost/api/subagents/settings", {
    method: "PUT",
    headers: { "Content-Type": contentType, Host: "localhost" },
    body: JSON.stringify(body),
  });
}

test("settings route defaults on and persists both switch states", async () => {
  let response = await GET(new Request("http://localhost/api/subagents/settings"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true, maxConcurrent: 10 });

  response = await PUT(request({ enabled: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true, maxConcurrent: 10 });
  assert.deepEqual(
    JSON.parse(await readFile(join(testAgentDir, "agents", "settings.json"), "utf8")),
    { version: 1, builtInEnabled: true },
  );

  response = await PUT(request({ enabled: false }));
  assert.deepEqual(await response.json(), { enabled: false, maxConcurrent: 10 });
});

test("settings route validates mutations", async () => {
  let response = await PUT(request({ enabled: "yes" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "enabled must be a boolean" });

  response = await PUT(request({ enabled: true }, "text/plain"));
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "Content-Type must be application/json" });

  response = await PUT(request({ maxConcurrent: 0 }));
  assert.equal(response.status, 400);
  response = await PUT(request({ maxConcurrent: 2 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.maxConcurrent, 2);
  assert.equal(typeof body.enabled, "boolean");
});

test("a project switch turns sub-agents off for that project only", async (t) => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-project-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  allowFileRoot(cwd);
  await PUT(request({ enabled: true }));

  let response = await PUT(request({ cwd, projectEnabled: false }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).project, { root: cwd, enabled: false });
  response = await GET(new Request(`http://localhost/api/subagents/settings?cwd=${encodeURIComponent(cwd)}`));
  assert.deepEqual((await response.json()).project, { root: cwd, enabled: false });

  response = await PUT(request({ cwd, projectEnabled: true }));
  assert.deepEqual((await response.json()).project, { root: cwd, enabled: true });

  // A cwd outside the allowed roots is refused before anything is written.
  response = await PUT(request({ cwd: "/", projectEnabled: false }));
  assert.equal(response.status, 403);
});
