import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const dir = await mkdtemp(join(tmpdir(), "pi-web-models-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(dir, { recursive: true, force: true });
});
const { PUT } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./route.ts");
const put = (config) => PUT(new Request("http://localhost/api/models-config", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config),
}));

test("save names an invalid provider with 400 and keeps the original file until repaired or deleted", async () => {
  const modelsPath = join(dir, "models.json");
  const original = JSON.stringify({ providers: { good: { headers: {} } } });
  await writeFile(modelsPath, original);
  for (const entry of [{ api: "openai-completions" }, { models: [{ id: " " }] }, { oauth: "radius" }]) {
    const response = await put({ providers: { good: { headers: {} }, unfinished: entry } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Provider unfinished/);
    assert.equal(await readFile(modelsPath, "utf8"), original);
  }
  assert.equal((await put({ providers: { good: { headers: {} } } })).status, 200);
  assert.equal((await put({ providers: { unfinished: { baseUrl: "https://example.test" } } })).status, 200);
});
