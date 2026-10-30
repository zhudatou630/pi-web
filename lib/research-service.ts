import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { isPathWithinRoots } from "./path-security";

export function researchHome(): string {
  return resolve(process.env.RESEARCH_LOOP_HOME || resolve(process.cwd(), ".."));
}

export async function researchService() {
  const value = JSON.parse(await readFile(resolve(researchHome(), "data/service.json"), "utf8")) as { port: number; token: string };
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== "string" || value.token.length < 32) {
    throw new Error("Invalid research service configuration");
  }
  return { ...value, url: `http://127.0.0.1:${value.port}` };
}

export async function isResearchWorker(req: Request): Promise<boolean> {
  const { token } = await researchService();
  const actual = Buffer.from(req.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function researchWorkspace(runId: string): Promise<string> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId)) throw new Error("Invalid run id");
  const root = await realpath(resolve(researchHome(), "data/runs"));
  const workspace = await realpath(resolve(root, runId, "workspace"));
  if (!isPathWithinRoots(workspace, new Set([root]))) throw new Error("Research workspace escapes the run root");
  return workspace;
}
