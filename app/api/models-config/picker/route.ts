import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { createModelsConfigServices, resolveAllowedCwd } from "@/lib/model-config-services";
import {
  applyPickerToggle,
  modelPickerRef,
  PickerToggleError,
  samePickerPatterns,
} from "@/lib/model-picker";
import { invalidateModelsCache } from "@/lib/models-cache";
import { resolveVisibleModels } from "@/lib/model-scope";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isRecord(body)) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const cwdValue = typeof body.cwd === "string" ? body.cwd.trim() : "";
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!cwdValue) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  if (!provider || !id) {
    return NextResponse.json({ error: "provider and id are required" }, { status: 400 });
  }
  if (typeof body.inPicker !== "boolean") {
    return NextResponse.json({ error: "inPicker must be a boolean" }, { status: 400 });
  }

  const resolved = await resolveAllowedCwd(cwdValue);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  try {
    const services = await createModelsConfigServices(resolved.cwd);
    const settings = services.settingsManager;
    const patterns = settings.getEnabledModels();
    const available = await services.modelRuntime.getAvailable();
    const scope = await resolveVisibleModels(services.modelRuntime, patterns);
    const result = applyPickerToggle({
      patterns,
      projectHasEnabledModels: Object.prototype.hasOwnProperty.call(
        settings.getProjectSettings(),
        "enabledModels",
      ),
      availableRefs: available.map((model) => modelPickerRef(model.provider, model.id)),
      visibleRefs: scope.visible.map((model) => modelPickerRef(model.provider, model.id)),
      ref: modelPickerRef(provider, id),
      inPicker: body.inPicker,
    });

    if (!samePickerPatterns(settings.getGlobalSettings().enabledModels, result.enabledModels)) {
      settings.setEnabledModels(result.enabledModels);
      await settings.flush();
      const writeError = settings.drainErrors()[0];
      if (writeError) {
        return NextResponse.json({ error: writeError.error.message }, { status: 500 });
      }
      invalidateModelsCache();
    }

    return NextResponse.json({ enabledModels: result.enabledModels });
  } catch (error) {
    if (error instanceof PickerToggleError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
