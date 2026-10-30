import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createModelsConfigServices } from "@/lib/model-config-services";
import { isResearchWorker, researchWorkspace } from "@/lib/research-service";
import { runResearchFigureJob } from "@/lib/research-figures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    if (!await isResearchWorker(req)) return Response.json({ error: "Worker authentication required" }, { status: 401 });
    const body = await req.json() as Parameters<typeof runResearchFigureJob>[2];
    const cwd = await researchWorkspace(body.runId);
    const services = await createModelsConfigServices(cwd);
    const result = await runResearchFigureJob(cwd, services.agentDir, body, {
      cwd, modelRegistry: new ModelRegistry(services.modelRuntime), sessionManager: { getBranch: () => [] },
    }, req.signal);
    return Response.json(result);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/sk-[A-Za-z0-9._-]+/g, "[redacted]");
    return Response.json({ error: message }, { status: 400 });
  }
}
