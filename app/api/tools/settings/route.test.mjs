import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-settings-route-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { GET, PUT } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./route.ts");
after(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(agentDir, { recursive: true, force: true });
});
const request = body => new Request("http://localhost/api/tools/settings", {
  method: "PUT", headers: { Host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("global built-in tools can be changed on every platform while retaining extension defaults", async () => {
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["+codemode"], other: "keep" }));
  assert.deepEqual((await (await GET()).json()).builtinTools, ["read", "edit", "write", "bash"]);
  const response = await PUT(request({ builtinTools: ["read", "grep"] }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).builtinTools, ["read", "grep"]);
  const saved = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.equal(saved.other, "keep");
  assert.ok(saved.defaultTools.includes("+codemode"));
});

test("invalid and mixed tool mutations are refused without changing settings", async () => {
  const before = await readFile(join(agentDir, "settings.json"), "utf8");
  for (const body of [null, [], {}, { builtinTools: ["extension"] }, { builtinTools: ["+read"] }, { builtinTools: "read" }, { builtinTools: [], enabled: true }]) {
    assert.equal((await PUT(request(body))).status, 400, JSON.stringify(body));
  }
  assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), before);
});
