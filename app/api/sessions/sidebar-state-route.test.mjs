import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, PATCH: bulkPatch } = await jiti.import("./route.ts");
const { PATCH } = await jiti.import("./[id]/route.ts");
const { invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");
const { listSessionFamilies, isFamilyArchived } = await jiti.import("../../../lib/session-family.ts");
const { IMAGE_RESULT_TYPE } = await jiti.import("../../../lib/image-generation.ts");

test("sidebar PATCH normalizes to family roots, syncs via list versions, never writes JSONL, and scanner activity restores archives", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "sidebar-api-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__piSessions = new Map();
  invalidateSessionListCache();
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    globalThis.__piSessions = previousRegistry;
    for (const id of ["sidebar-root", "sidebar-child", "sidebar-other"]) invalidateSessionPathCache(id);
    invalidateSessionListCache();
    await rm(agentDir, { recursive: true, force: true });
  });
  const dir = join(agentDir, "sessions", "fixture");
  await mkdir(dir, { recursive: true });
  const rootPath = join(dir, "root.jsonl");
  const childPath = join(dir, "child.jsonl");
  const timestamp = "2026-01-01T00:00:00.000Z";
  const header = (id, parentSession) => ({ type: "session", version: 3, id, cwd: agentDir, timestamp, ...(parentSession ? { parentSession } : {}) });
  const metadata = { type: "custom", customType: "pi-web:subagent", id: "meta", parentId: null, timestamp,
    data: { version: 1, parentSessionId: "sidebar-root", parentSessionPath: rootPath, profile: "Explore", description: "Child" } };
  const rootBytes = JSON.stringify(header("sidebar-root")) + "\n";
  const childBytes = [header("sidebar-child", rootPath), metadata].map(JSON.stringify).join("\n") + "\n";
  await writeFile(rootPath, rootBytes);
  await writeFile(childPath, childBytes);
  const list = async (force = false) => {
    const response = await GET(new Request(`http://localhost/api/sessions${force ? "?force=1" : ""}`));
    assert.equal(response.status, 200);
    return response.json();
  };
  const patch = (id, body) => PATCH(new Request(`http://localhost/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const initial = await list(true);
  assert.equal((await patch("sidebar-child", { pinned: true })).status, 200);
  let data = await list();
  assert.deepEqual(data.pinnedSessionIds, ["sidebar-root"]);
  assert.ok(data.sessionListVersion > initial.sessionListVersion);
  assert.equal((await patch("sidebar-child", { archived: true })).status, 200);
  data = await list();
  assert.deepEqual(data.pinnedSessionIds, []);
  assert.ok(data.archivedSessionIds["sidebar-root"]);
  assert.equal(isFamilyArchived(listSessionFamilies(data.sessions)[0], data.archivedSessionIds, new Set()), true);
  assert.equal(await readFile(rootPath, "utf8"), rootBytes);
  assert.equal(await readFile(childPath, "utf8"), childBytes);
  // File metadata and session-info entries are not message activity.
  await utimes(rootPath, new Date("2099-01-01"), new Date("2099-01-01"));
  data = await list(true);
  assert.equal(isFamilyArchived(listSessionFamilies(data.sessions)[0], data.archivedSessionIds, new Set()), true);
  // An external CLI append of a generated-image message counts too.
  const imageTimestamp = new Date(Date.parse(data.archivedSessionIds["sidebar-root"]) + 1000).toISOString();
  await appendFile(rootPath, JSON.stringify({ type: "custom_message", customType: IMAGE_RESULT_TYPE, timestamp: imageTimestamp, details: { prompt: "Generated image" } }) + "\n");
  data = await list(true);
  assert.equal(isFamilyArchived(listSessionFamilies(data.sessions)[0], data.archivedSessionIds, new Set()), false);
  assert.equal((await patch("sidebar-root", { pinned: true })).status, 200);
  data = await list();
  assert.deepEqual(data.archivedSessionIds, {});
  assert.equal((await patch("sidebar-root", { pinned: true, archived: true })).status, 400);
  assert.equal((await patch("sidebar-root", { archived: "yes" })).status, 400);
  // A running child prevents the family's archive even when the root is idle.
  globalThis.__piSessions = new Map([["sidebar-child", { isAlive: () => false, isRunning: () => true }]]);
  assert.equal((await patch("sidebar-root", { archived: true })).status, 409);
  globalThis.__piSessions = new Map();

  await t.test("collection archive validates the 500-id cap and writes all resolved families once, or none on conflict", async () => {
    const otherPath = join(dir, "other.jsonl");
    const otherBytes = JSON.stringify(header("sidebar-other")) + "\n";
    await writeFile(otherPath, otherBytes);
    data = await list(true);
    const rootBeforeBulk = await readFile(rootPath, "utf8");
    const bulk = (body) => bulkPatch(new Request("http://localhost/api/sessions", { method: "PATCH", body: JSON.stringify(body) }));
    for (const body of [null, [], {}, { ids: [], archived: true }, { ids: ["sidebar-root"], archived: "yes" },
      { ids: [null], archived: true }, { ids: ["../escape"], archived: true },
      { ids: Array(501).fill("sidebar-root"), archived: true }]) {
      assert.equal((await bulk(body)).status, 400);
    }
    assert.equal((await bulkPatch(new Request("http://localhost/api/sessions", { method: "PATCH", body: "{broken" }))).status, 400);
    assert.equal((await bulk({ ids: ["sidebar-other", "missing"], archived: true })).status, 404);
    assert.deepEqual((await list()).archivedSessionIds, {});
    globalThis.__piSessions = new Map([["sidebar-child", { isAlive: () => false, isRunning: () => true }]]);
    assert.equal((await bulk({ ids: ["sidebar-other", "sidebar-root"], archived: true })).status, 409);
    globalThis.__piSessions = new Map();
    assert.deepEqual((await list()).archivedSessionIds, {}, "conflict must not partially archive the idle family");
    const beforeBulk = await list();
    assert.equal((await bulk({ ids: ["sidebar-other", "sidebar-child", "sidebar-root", "sidebar-child"], archived: true })).status, 200);
    data = await list();
    assert.deepEqual(new Set(Object.keys(data.archivedSessionIds)), new Set(["sidebar-root", "sidebar-other"]));
    assert.equal(data.archivedSessionIds["sidebar-root"], data.archivedSessionIds["sidebar-other"], "one write uses one archive timestamp");
    assert.deepEqual(data.pinnedSessionIds, []);
    assert.ok(data.sessionListVersion > beforeBulk.sessionListVersion);
    // Exactly the cap is accepted, even with repeated ids; root normalization remains idempotent.
    assert.equal((await bulk({ ids: Array(500).fill("sidebar-root"), archived: false })).status, 200);
    assert.deepEqual(Object.keys((await list()).archivedSessionIds), ["sidebar-other"]);
    assert.equal((await bulk({ ids: ["sidebar-other"], archived: false })).status, 200);
    assert.deepEqual((await list()).archivedSessionIds, {});
    assert.equal(await readFile(rootPath, "utf8"), rootBeforeBulk);
    assert.equal(await readFile(childPath, "utf8"), childBytes);
    assert.equal(await readFile(otherPath, "utf8"), otherBytes);
    const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");
    assert.equal([...routeSource.matchAll(/await updateSidebarState\(/g)].length, 1);
    assert.equal([...routeSource.matchAll(/listSessionFamilies\(sessions\)/g)].length, 1);
  });
});
