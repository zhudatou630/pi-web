import { createModelsConfigServices } from "@/lib/model-config-services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Enumerate the server's trusted configuration even before the first chat
    // has registered a file root. No caller-supplied cwd or credentials leave here.
    const services = await createModelsConfigServices(process.cwd());
    const models = await services.modelRuntime.getAvailable();
    return Response.json({ modelList: models.map(model => ({ id: model.id, provider: model.provider, name: model.name })) });
  } catch {
    return Response.json({ modelList: [], error: "Pi model configuration could not be loaded" });
  }
}
