import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-auto-trust-callers-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url);
const { saveMcpServer } = await jiti.import("./mcp-config.ts");
const { setProjectOverrides } = await jiti.import("./project-resource-overrides.ts");
const { saveSubagentProfile } = await jiti.import("./subagents.ts");
const { ProjectTrustStore } = await jiti.import("@earendil-works/pi-coding-agent");

test("both auto-trusting config writers refuse unseen nested projects before writing", async () => {
  const store = new ProjectTrustStore(agentDir);
  const writers = [
    (cwd) => saveMcpServer({ cwd, scope: "project", name: "probe", config: { command: "probe" } }, agentDir),
    (cwd) => setProjectOverrides(cwd, agentDir, [{ type: "extensions", path: "builtin:mcp" }], false),
  ];
  for (const [i, write] of writers.entries()) {
    const cwd = join(root, `container-${i}`);
    const nested = join(cwd, "clone");
    mkdirSync(join(nested, ".pi", "extensions"), { recursive: true });
    await assert.rejects(write(cwd), /unseen/);
    assert.equal(existsSync(join(cwd, ".pi")), false);
    assert.equal(store.get(nested), null);
    // A child's explicit refusal remains in force even after trusting the parent.
    store.set(nested, false);
    await write(cwd);
    assert.equal(store.get(cwd), true);
    assert.equal(store.get(nested), false);
  }
  assert.ok(Object.values(JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8"))).includes(false));
});

test("project writers honor a saved Do not trust on a project with nothing to gate", async () => {
  const store = new ProjectTrustStore(agentDir);
  const writers = [
    (cwd) => saveMcpServer({ cwd, scope: "project", name: "probe", config: { command: "probe" } }, agentDir),
    (cwd) => setProjectOverrides(cwd, agentDir, [{ type: "extensions", path: "builtin:mcp" }], false),
    async (cwd) => saveSubagentProfile(cwd, "project", { name: "probe", description: "d", tools: [], systemPrompt: "p" }),
  ];
  for (const [i, write] of writers.entries()) {
    const cwd = join(root, `distrusted-${i}`);
    mkdirSync(cwd);
    store.set(cwd, false);
    await assert.rejects(write(cwd), /trust/i);
    assert.equal(existsSync(join(cwd, ".pi")), false);
    assert.equal(store.get(cwd), false);
  }
});
