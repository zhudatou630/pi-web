import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-route-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "extensions"), { recursive: true });
await mkdir(cwd);
await writeFile(join(agentDir, "extensions", "rtk.ts"), "export default () => {};\n");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { GET, POST } = await jiti.import("./route.ts");
allowFileRoot(cwd);

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

test("lists auto-discovered top-level extensions", async () => {
  const response = await GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.packages, []);
  assert.deepEqual(body.standaloneExtensions, [{
    kind: "extension",
    name: "rtk",
    path: join(agentDir, "extensions", "rtk.ts"),
    relativePath: "extensions/rtk.ts",
    scope: "global",
    enabled: true,
    globalEnabled: true,
    projectOverride: "inherit",
  }]);
  assert.equal(body.totals.extensions, 1);
});

function post(body) {
  return POST(new Request("http://localhost/api/plugins", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({ cwd, ...body }),
  }));
}

test("switches a single package skill globally without touching the rest of the package", async () => {
  const pkg = join(root, "pkg");
  for (const name of ["kept", "dropped"]) {
    await mkdir(join(pkg, "skills", name), { recursive: true });
    await writeFile(join(pkg, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nx\n`);
  }
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
  const dropped = join(pkg, "skills", "dropped", "SKILL.md");

  const response = await post({ action: "disable-resource", kind: "skill", path: dropped });
  assert.equal(response.status, 200);
  const skills = (await response.json()).packages[0].resources.filter((resource) => resource.kind === "skill");
  assert.deepEqual(
    skills.map((resource) => [resource.name, resource.globalEnabled]).sort(),
    [["dropped", false], ["kept", true]],
  );

  // Only the four resource kinds map to a settings key.
  assert.equal((await post({ action: "enable-resource", kind: "constructor", path: dropped })).status, 400);
});
