import { NextResponse } from "next/server";
import { getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { createModelsConfigServices, resolveAllowedCwd } from "@/lib/model-config-services";
import {
  describeEnabledModels,
  enabledModelsWriteScope,
  modelPickerRef,
  normalizePatterns,
  patternsToStore,
  samePickerPatterns,
  type EnabledModelsDocument,
  type EnabledModelsPanelState,
} from "@/lib/model-picker";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { resolveVisibleModels } from "@/lib/model-scope";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storedPatterns(settings: { enabledModels?: string[] }): { hasKey: boolean; patterns: string[] | undefined } {
  // setEnabledModels(undefined) leaves the property in memory. Only a real array is a key.
  return Array.isArray(settings.enabledModels)
    ? { hasKey: true, patterns: settings.enabledModels }
    : { hasKey: false, patterns: undefined };
}

function readEnabledModelsDocument(cwd: string, settings: SettingsManager): EnabledModelsDocument {
  const global = storedPatterns(settings.getGlobalSettings());
  const project = storedPatterns(settings.getProjectSettings());
  return describeEnabledModels({
    globalPatterns: global.patterns,
    globalHasKey: global.hasKey,
    projectPatterns: project.patterns,
    projectHasKey: project.hasKey,
    projectWritable: getProjectTrustStatus(cwd, getAgentDir()).trusted,
  });
}

/**
 * The list the panel renders, plus the document behind it. Globs and bare ids
 * are resolved here so the panel never has to show them.
 */
async function readPanelState(
  cwd: string,
  settings: SettingsManager,
  modelRuntime: ModelRuntime,
): Promise<EnabledModelsPanelState> {
  const document = readEnabledModelsDocument(cwd, settings);
  const scope = await resolveVisibleModels(modelRuntime, document.patterns);
  return {
    ...document,
    visible: scope.visible.map((model) => ({ provider: model.provider, id: model.id })),
    pins: scope.thinkingLevelPins,
    // Credential-blind: what the definition layers know, so the panel can tell a
    // deleted definition from a provider that is merely unreachable right now.
    defined: modelRuntime.getModels().map((model) => modelPickerRef(model.provider, model.id)),
    ...(scope.ambiguous.length > 0 ? { ambiguous: scope.ambiguous } : {}),
  };
}

type ProjectEnabledModelsWriter = {
  updateProjectSettings(
    field: "enabledModels",
    update: (settings: { enabledModels?: string[] }) => void,
  ): void;
};

function writeEnabledModels(
  settings: SettingsManager,
  scope: "global" | "project",
  patterns: string[] | undefined,
): void {
  if (scope === "global") {
    settings.setEnabledModels(patterns);
    return;
  }
  // SDK writes this key only through the private project updater. It keeps the file lock and other keys.
  (settings as unknown as ProjectEnabledModelsWriter).updateProjectSettings("enabledModels", (project) => {
    if (patterns && patterns.length > 0) project.enabledModels = patterns;
    else delete project.enabledModels;
  });
}

export async function GET(req: Request) {
  const requestedCwd = new URL(req.url).searchParams.get("cwd");
  if (!requestedCwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  const resolved = await resolveAllowedCwd(requestedCwd);
  if ("error" in resolved) return NextResponse.json({ error: resolved.error }, { status: resolved.status });

  try {
    const services = await createModelsConfigServices(resolved.cwd);
    return NextResponse.json(await readPanelState(resolved.cwd, services.settingsManager, services.modelRuntime));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
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
  if (!isRecord(body) || !Array.isArray(body.patterns) || body.patterns.some((pattern) => typeof pattern !== "string")) {
    return NextResponse.json({ error: "patterns must be a string array" }, { status: 400 });
  }
  const cwdValue = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!cwdValue) return NextResponse.json({ error: "cwd is required" }, { status: 400 });

  const resolved = await resolveAllowedCwd(cwdValue);
  if ("error" in resolved) return NextResponse.json({ error: resolved.error }, { status: resolved.status });

  try {
    const services = await createModelsConfigServices(resolved.cwd);
    const settings = services.settingsManager;
    const current = readEnabledModelsDocument(resolved.cwd, settings);
    if (current.readOnly) {
      return NextResponse.json({ error: "Project is not trusted", code: "untrusted" }, { status: 403 });
    }

    const next = normalizePatterns(body.patterns);
    const deleting = next.length === 0;
    const unchanged = deleting ? current.source === "none" : samePickerPatterns(current.patterns, next);
    if (!unchanged) {
      writeEnabledModels(settings, enabledModelsWriteScope(current.source), patternsToStore(next));
      await settings.flush();
      const writeError = settings.drainErrors()[0];
      if (writeError) {
        return NextResponse.json({ error: writeError.error.message }, { status: 500 });
      }
      invalidateModelsCache();
    }
    return NextResponse.json(await readPanelState(resolved.cwd, settings, services.modelRuntime));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
