import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagent-import-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../../../lib/file-access.ts");
const { listAllSessions } = await jiti.import("../../../../../lib/session-reader.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

const url = (params) => new Request(`http://localhost/api/subagents/profiles/import?${new URLSearchParams(params)}`);
const post = (body) => POST(new Request("http://localhost/api/subagents/profiles/import", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

/** A checkout the app "knows": it has a session with that cwd. */
async function knownProject(prefix, agents = {}) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, ".pi", "agents"), { recursive: true });
  for (const [file, text] of Object.entries(agents)) await writeFile(join(dir, ".pi", "agents", file), text);
  const sessionDir = join(testAgentDir, "sessions", `--${dir.replace(/[^\w]/g, "-")}--`);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, `2026-01-01T00-00-00-000Z_${crypto.randomUUID()}.jsonl`), [
    { type: "session", version: 3, id: crypto.randomUUID(), timestamp: "2026-01-01T00:00:00.000Z", cwd: dir },
    { type: "message", id: "aaaaaaaa", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1 } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  await listAllSessions({ force: true });
  return dir;
}

test("sources list other known projects that have agent files; anything else is refused", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-import-cwd-"));
  allowFileRoot(cwd);
  const withAgents = await knownProject("pi-web-import-with-", {
    "good.md": "---\ndescription: Imported\nowner: team\n---\nImported prompt.\n",
    "broken.md": "---\nbroken: [\n---\n",
  });
  const empty = await knownProject("pi-web-import-empty-");
  const unknown = await mkdtemp(join(tmpdir(), "pi-web-import-unknown-"));
  await mkdir(join(unknown, ".pi", "agents"), { recursive: true });
  await writeFile(join(unknown, ".pi", "agents", "x.md"), "---\ndescription: X\n---\nX.\n");
  t.after(() => Promise.all([cwd, withAgents, empty, unknown].map((dir) => rm(dir, { recursive: true, force: true }))));

  const sources = (await (await GET(url({ cwd }))).json()).sources;
  assert.deepEqual(sources.map((source) => [source.dir, source.count]), [[withAgents, 2]]);

  // A folder with no session history, or the current project itself, cannot be a source.
  assert.equal((await GET(url({ cwd, sourceDir: unknown }))).status, 403);
  assert.equal((await GET(url({ cwd, sourceDir: cwd }))).status, 403);
  assert.equal((await post({ cwd, sourceDir: unknown, scope: "project", files: ["x.md"] })).status, 403);

  const preview = await GET(url({ cwd, sourceDir: withAgents }));
  const { items } = await preview.json();
  assert.deepEqual(items.map((item) => item.file), ["broken.md", "good.md"]);
  assert.equal(items.find((item) => item.file === "good.md").error, undefined);
  assert.ok(items.find((item) => item.file === "broken.md").error);

  let response = await post({ cwd, sourceDir: withAgents, scope: "project", files: ["good.md", "broken.md"] });
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  assert.deepEqual(result.imported, ["good.md"]);
  assert.equal(result.skipped.length, 1);
  // Byte copy keeps frontmatter keys the app does not model.
  const text = await readFile(join(cwd, ".pi", "agents", "good.md"), "utf8");
  assert.match(text, /owner: team/);

  response = await post({ cwd, sourceDir: withAgents, scope: "project", files: ["good.md"] });
  const again = (await response.json()).result;
  assert.deepEqual(again.imported, []);
  assert.equal(again.skipped[0].reason, "Already exists");
});
