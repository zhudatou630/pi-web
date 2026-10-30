/** Run-scoped scientific-figure jobs using Pi's existing image execution layer. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { imageConfigView, resolveImageConfig } from "./image-generation-config";
import { executeImageGeneration } from "./image-generation-runtime";
import { MAX_REFERENCE_IMAGES } from "./image-generation";
import { isPathWithinRoots } from "./path-security";

type Context = Parameters<typeof executeImageGeneration>[2];
type Generate = typeof executeImageGeneration;
type FigureRequest = { runId: string; jobId: string; action?: "generate" | "status" | "abort"; prompt?: string;
  connection?: string; size?: string; quality?: string; reference_images?: string[] };
type Manifest = { schema_version: number; run_id: string; job_id: string; request_sha256: string;
  status: "running" | "completed" | "failed"; result?: Awaited<ReturnType<Generate>>;
  output_sha256?: string; error?: string; updated_at: string };
const shared = globalThis as typeof globalThis & { __apdFigureJobs?: Map<string, { controller: AbortController; promise: Promise<unknown>; digest: string }> };
const active = shared.__apdFigureJobs ??= new Map();
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const safe = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/sk-[A-Za-z0-9._-]+/g, "[redacted]");

export async function runResearchFigureJob(workspace: string, agentDir: string, body: FigureRequest,
    context: Context, signal?: AbortSignal, generate: Generate = executeImageGeneration) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(body.jobId || "")) throw new Error("Invalid figure job ID");
  workspace = await realpath(workspace);
  const folder = path.join(workspace, ".apd-figure-jobs");
  await mkdir(folder, { recursive: true });
  if (!isPathWithinRoots(await realpath(folder), new Set([workspace]))) throw new Error("Figure job folder escapes workspace");
  const file = path.join(folder, body.jobId + ".json");
  if (await lstat(file).then(info => info.isSymbolicLink()).catch(() => false)) throw new Error("Figure manifest may not be a symlink");
  const key = workspace + ":" + body.jobId;
  if (body.action === "abort") {
    active.get(key)?.controller.abort(new DOMException("Figure job cancelled", "AbortError"));
    return { job_id: body.jobId, abort_requested: true };
  }
  const read = async (): Promise<Manifest | null> => {
    try { return JSON.parse(await readFile(file, "utf8")) as Manifest; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  if (body.action === "status") return await read() ?? { job_id: body.jobId, status: "not_found" };
  if (body.action && body.action !== "generate") throw new Error("Unknown figure action");
  if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 32000) throw new Error("Invalid scientific figure prompt");
  if (body.reference_images && (!Array.isArray(body.reference_images) || body.reference_images.some(value => typeof value !== "string" || value.startsWith("attachment:")))) {
    throw new Error("Headless figure jobs require workspace file references");
  }
  if ((body.reference_images?.length ?? 0) > MAX_REFERENCE_IMAGES) throw new Error("Too many figure references");
  const referenceHashes = [];
  for (const reference of body.reference_images ?? []) {
    const source = await realpath(path.resolve(workspace, reference));
    if (!isPathWithinRoots(source, new Set([workspace]))) throw new Error("Figure reference escapes workspace");
    referenceHashes.push(sha(await readFile(source)));
  }
  const config = resolveImageConfig(agentDir, workspace);
  if (!config.enabled) throw new Error("Image generation is disabled in this project");
  const connection = body.connection || imageConfigView(config).defaultConnection;
  const request = { prompt: body.prompt, connection, reference_images: body.reference_images ?? [],
    ...(body.size ? { size: body.size } : {}), ...(body.quality ? { quality: body.quality } : {}) };
  const digest = sha(JSON.stringify({ ...request, reference_sha256: referenceHashes }));
  const existing = await read();
  if (existing && existing.request_sha256 !== digest) throw new Error("Figure job ID already belongs to different inputs");
  if (existing?.status === "completed" && existing.result) {
    const output = await realpath(path.resolve(workspace, existing.result.path));
    if (!isPathWithinRoots(output, new Set([workspace])) || sha(await readFile(output)) !== existing.output_sha256) throw new Error("Cached figure output is missing, modified or outside the workspace");
    return { ...existing, cached: true };
  }
  const running = active.get(key);
  if (running) {
    if (running.digest !== digest) throw new Error("Figure job ID already belongs to different active inputs");
    return running.promise;
  }
  if (existing?.status === "running") throw new Error("Previous figure job was interrupted; use a new job ID to retry explicitly");
  if (existing?.status === "failed") throw new Error("Figure job previously failed; use a new job ID to retry explicitly");
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const save = async (manifest: Manifest) => {
    const temporary = file + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  };
  const manifest: Manifest = { schema_version: 1, run_id: body.runId, job_id: body.jobId,
    request_sha256: digest, status: "running", updated_at: new Date().toISOString() };
  const promise = (async () => {
    await save(manifest);
    try {
      const result = await generate(agentDir, request, context, combined);
      const output = await realpath(path.resolve(workspace, result.path));
      if (!isPathWithinRoots(output, new Set([workspace]))) throw new Error("Figure output escapes workspace");
      Object.assign(manifest, { status: "completed", result, output_sha256: sha(await readFile(output)), updated_at: new Date().toISOString() });
      await save(manifest);
      return { ...manifest, cached: false };
    } catch (error) {
      Object.assign(manifest, { status: "failed", error: safe(error), updated_at: new Date().toISOString() });
      await save(manifest);
      throw new Error(safe(error));
    }
  })();
  active.set(key, { controller, promise, digest });
  try { return await promise; } finally { active.delete(key); }
}
