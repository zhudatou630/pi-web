import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { isResearchWorker, researchService, researchWorkspace } = await jiti.import("./research-service.ts");
const route = await jiti.import("../app/api/research/[...path]/route.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "research-bridge-"));
  const old = process.env.RESEARCH_LOOP_HOME;
  process.env.RESEARCH_LOOP_HOME = root;
  t.after(async () => {
    if (old === undefined) delete process.env.RESEARCH_LOOP_HOME;
    else process.env.RESEARCH_LOOP_HOME = old;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "data"));
  const token = "synthetic-worker-token-for-local-tests-only";
  await writeFile(join(root, "data/service.json"), JSON.stringify({ port: 30145, token }));
  return { root, token };
}

test("private runtime token is mandatory even with no Pi Web password", async t => {
  const { token } = await fixture(t);
  assert.equal(await isResearchWorker(new Request("http://localhost/api/research/runtime")), false);
  assert.equal(await isResearchWorker(new Request("http://localhost/api/research/runtime", { headers: { authorization: "Bearer wrong" } })), false);
  assert.equal(await isResearchWorker(new Request("http://localhost/api/research/runtime", { headers: { authorization: `Bearer ${token}` } })), true);
  assert.equal((await researchService()).url, "http://127.0.0.1:30145");
});

test("research workspace resolution rejects path traversal and links outside the run root", async t => {
  const { root } = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000000";
  const parent = join(root, "data/runs", id);
  await mkdir(join(parent, "workspace"), { recursive: true });
  assert.equal(await researchWorkspace(id), join(parent, "workspace"));
  await assert.rejects(() => researchWorkspace("../../outside"), /Invalid run/);
  const other = "00000000-0000-4000-8000-000000000001";
  const outside = await mkdtemp(join(tmpdir(), "research-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(root, "data/runs", other));
  await symlink(outside, join(root, "data/runs", other, "workspace"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => researchWorkspace(other), /escapes/);
});

test("browser proxy cannot forward to the model gateway and never returns the worker token", async t => {
  const { token } = await fixture(t);
  const blocked = await route.POST(new Request("http://localhost/api/research/llm/x/chat/completions", { method: "POST" }),
    { params: Promise.resolve({ path: ["llm", "x", "chat", "completions"] }) });
  assert.equal(blocked.status, 404);
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "http://127.0.0.1:30145/v1/health");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return Response.json({ ok: true });
  };
  const response = await route.GET(new Request("http://localhost/api/research/health"), { params: Promise.resolve({ path: ["health"] }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.has("authorization"), false);
});
