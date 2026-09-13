import { NextResponse } from "next/server";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModelsConfigServices, resolveAllowedCwd } from "@/lib/model-config-services";
import { modelPickerRef, type RuntimeCatalogModel } from "@/lib/model-picker";
import { resolveVisibleModels } from "@/lib/model-scope";

export const dynamic = "force-dynamic";

function serializeRuntimeModel(model: Model<Api>, inPicker: boolean): RuntimeCatalogModel {
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
    inPicker,
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
    const services = await createModelsConfigServices(resolved.cwd);
    const patterns = services.settingsManager.getEnabledModels();
    const available = await services.modelRuntime.getAvailable();
    const scope = await resolveVisibleModels(services.modelRuntime, patterns);
    const visible = new Set(scope.visible.map((model) => modelPickerRef(model.provider, model.id)));
    const catalog = available.map((model) => serializeRuntimeModel(
      model,
      visible.has(modelPickerRef(model.provider, model.id)),
    ));
    return NextResponse.json({
      catalog,
      enabledModels: patterns ?? [],
      unscoped: !patterns?.length,
      ...(services.modelRuntime.getError() ? { modelError: services.modelRuntime.getError() } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
