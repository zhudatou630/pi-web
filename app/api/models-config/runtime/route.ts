import { NextResponse } from "next/server";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModelsConfigServices, resolveAllowedCwd } from "@/lib/model-config-services";
import type { RuntimeCatalogModel } from "@/lib/model-picker";
import { readModelsConfigResult } from "@/lib/models-config-store";

export const dynamic = "force-dynamic";

function serializeRuntimeModel(model: Model<Api>): RuntimeCatalogModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: {
      input: model.cost?.input,
      output: model.cost?.output,
      cacheRead: model.cost?.cacheRead,
      cacheWrite: model.cost?.cacheWrite,
    },
    ...(model.headers ? { headers: model.headers } : {}),
    ...(model.compat ? { compat: model.compat as Record<string, unknown> } : {}),
  };
}

export async function GET(req: Request) {
  const requestedCwd = new URL(req.url).searchParams.get("cwd");
  if (!requestedCwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  const resolved = await resolveAllowedCwd(requestedCwd);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  try {
    const configRead = readModelsConfigResult();
    const services = await createModelsConfigServices(resolved.cwd);
    const available = await services.modelRuntime.getAvailable();
    const catalog = available.map((model) => serializeRuntimeModel(model));
    // A models.json that the SDK cannot load disables every provider defined in
    // it without any other visible symptom, so surface both layers' errors.
    const modelError = [configRead.error, services.modelRuntime.getError()].filter(Boolean).join("\n\n");
    return NextResponse.json({
      catalog,
      ...(modelError ? { modelError } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
