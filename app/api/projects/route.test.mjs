import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { DELETE: deleteProject } = await jiti.import("./route.ts");
const { invalidateSessionListCache, listAllSessions } = await jiti.import("../../../lib/session-reader.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

test("deleting a project removes all its sessions and unlinks outside forks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-delete-project-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    invalidateSessionListCache();
    await rm(root, { recursive: true, force: true });
  });
  const projectA = join(root, "a");
  const projectB = join(root, "b");
  await mkdir(projectA);
  await mkdir(projectB);
  const create = (cwd) => {
    const manager = SessionManager.create(cwd);
    manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() });
    return manager.getSessionFile();
  };
  const a1 = create(projectA);
  const a2 = create(projectA);
  const fork = create(projectB);
  const lines = (await readFile(fork, "utf8")).split("\n");
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), parentSession: a1 });
  await writeFile(fork, lines.join("\n"));

  const sessions = await listAllSessions({ force: true });
  const keyA = sessions.find((session) => session.path === a1).projectKey;
  const request = (body) => new Request("http://localhost/api/projects", { method: "DELETE", body: JSON.stringify(body) });

  assert.equal((await deleteProject(request({}))).status, 400);
  assert.equal((await deleteProject(request({ projectKey: "/not/a/project" }))).status, 404);

  const response = await deleteProject(request({ projectKey: keyA }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deletedSessionIds.length, 2);
  await assert.rejects(readFile(a1), { code: "ENOENT" });
  await assert.rejects(readFile(a2), { code: "ENOENT" });
  assert.equal(JSON.parse((await readFile(fork, "utf8")).split("\n")[0]).parentSession, undefined);
  const remaining = await listAllSessions({ force: true });
  assert.deepEqual(remaining.map((session) => session.path), [fork]);
});
