import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { runResearchFigureJob } = await jiti.import("./research-figures.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "apd-figures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), agent = join(root, "agent");
  await mkdir(workspace); await mkdir(agent);
  await writeFile(join(agent, "images.json"), JSON.stringify({ default: "existing", connections: {
    existing: { provider: "configured", model: "image", capabilities: { sizes: ["auto"] } },
  } }));
  const body = { runId: "00000000-0000-4000-8000-000000000000", jobId: "figure-1", prompt: "Scientific flow" };
  const context = { cwd: workspace, sessionManager: { getBranch: () => [] }, modelRegistry: {} };
  let calls = 0;
  const generate = async (_agent, request) => {
    calls++;
    assert.equal(request.connection, "existing"); // Reuse the selected connection; never an implicit OAuth fallback.
    await writeFile(join(workspace, "image.png"), "synthetic-image-bytes");
    return { path: "image.png", type: "image_generation", version: 1 };
  };
  return { workspace, agent, body, context, generate, calls: () => calls };
}

test("figure jobs cache completed outputs and detect changed inputs or files", async t => {
  const f = await fixture(t);
  const run = body => runResearchFigureJob(f.workspace, f.agent, body, f.context, undefined, f.generate);
  assert.equal((await run(f.body)).status, "completed");
  assert.equal((await run(f.body)).cached, true);
  assert.equal(f.calls(), 1);
  await assert.rejects(() => run({ ...f.body, prompt: "Other input" }), /different inputs/);
  await writeFile(join(f.workspace, "image.png"), "modified");
  await assert.rejects(() => run(f.body), /modified/);
});

test("jobs reject traversal, headless attachment references and disabled settings", async t => {
  const f = await fixture(t);
  const run = body => runResearchFigureJob(f.workspace, f.agent, body, f.context, undefined, f.generate);
  await assert.rejects(() => run({ ...f.body, jobId: "../escape" }), /Invalid figure job ID/);
  await assert.rejects(() => run({ ...f.body, reference_images: ["attachment:1"] }), /workspace file/);
  await mkdir(join(f.agent, "images"));
  await writeFile(join(f.agent, "images/settings.json"), JSON.stringify({ enabled: false }));
  await assert.rejects(() => run(f.body), /disabled/);
  assert.equal(f.calls(), 0);
});

test("concurrent job IDs cannot acquire different prompts", async t => {
  const f = await fixture(t);
  let finish, notify;
  const started = new Promise(resolve => { notify = resolve; });
  const wait = new Promise(resolve => { finish = resolve; });
  const generate = async (...args) => { notify(); await wait; return f.generate(...args); };
  const first = runResearchFigureJob(f.workspace, f.agent, f.body, f.context, undefined, generate);
  await started;
  const status = await runResearchFigureJob(f.workspace, f.agent, { ...f.body, action: "status" }, f.context);
  assert.equal(status.status, "running");
  await assert.rejects(() => runResearchFigureJob(f.workspace, f.agent, { ...f.body, prompt: "Conflict" }, f.context), /different/);
  const same = runResearchFigureJob(f.workspace, f.agent, f.body, f.context, undefined, generate);
  finish();
  assert.equal((await first).status, "completed");
  assert.equal((await same).status, "completed");
  assert.equal(f.calls(), 1);
});

test("cancelled and failed jobs remain failed and never silently reissue a charged request", async t => {
  const f = await fixture(t);
  let notify;
  const started = new Promise(resolve => { notify = resolve; });
  const generate = async (_agent, _request, _context, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("cancelled sk-synthetic-not-a-real-key")), { once: true });
    notify();
  });
  const first = runResearchFigureJob(f.workspace, f.agent, f.body, f.context, undefined, generate);
  const failure = assert.rejects(first, /cancelled \[redacted\]/);
  await started;
  await runResearchFigureJob(f.workspace, f.agent, { ...f.body, action: "abort" }, f.context);
  await failure;
  const file = await readFile(join(f.workspace, ".apd-figure-jobs/figure-1.json"), "utf8");
  assert.equal(JSON.parse(file).status, "failed");
  assert.ok(!file.includes("sk-synthetic"));
  await assert.rejects(() => runResearchFigureJob(f.workspace, f.agent, f.body, f.context), /previously failed/);
});

test("generated files outside the run workspace cannot be admitted", async t => {
  const f = await fixture(t);
  await writeFile(join(f.agent, "outside.png"), "outside");
  await assert.rejects(() => runResearchFigureJob(f.workspace, f.agent, f.body, f.context, undefined,
    async () => ({ path: join(f.agent, "outside.png") })), /escapes workspace/);
});

test("editing reference contents are bound to request identity", async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "reference.png"), "original-reference");
  const body = { ...f.body, reference_images: ["reference.png"] };
  const run = () => runResearchFigureJob(f.workspace, f.agent, body, f.context, undefined, f.generate);
  await run();
  await writeFile(join(f.workspace, "reference.png"), "changed-reference");
  await assert.rejects(run, /different inputs/);
  await assert.rejects(() => runResearchFigureJob(f.workspace, f.agent,
    { ...f.body, jobId: "outside-ref", reference_images: [join(f.agent, "images.json")] }, f.context), /reference escapes/);
});

test("figure API requires worker authentication before reading any body or model settings", async () => {
  const route = await jiti.import("../app/api/research/figures/route.ts");
  const response = await route.POST(new Request("http://localhost/api/research/figures", { method: "POST", body: "not-json" }));
  assert.equal(response.status, 401);
});
