import { NextResponse } from "next/server";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  ImageConfigError,
  imageSettingsApiResponse,
  writeImageGenerationSettings,
  type ImageSettingsPatch,
} from "@/lib/image-generation-config";

export const dynamic = "force-dynamic";

async function imageSettingsResponse(modelRuntime?: ModelRuntime) {
  const agentDir = getAgentDir();
  const runtime = modelRuntime ?? await ModelRuntime.create();
  return imageSettingsApiResponse(agentDir, {
    hasAuth: (provider) => runtime.getProviderAuthStatus(provider).configured,
    providerName: (id) => runtime.getProvider(id)?.name ?? id,
  });
}

export async function GET() {
  try {
    return NextResponse.json(await imageSettingsResponse());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      enabled?: unknown;
      default?: unknown;
      connections?: unknown;
    };
    const patch: ImageSettingsPatch = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
      }
      patch.enabled = body.enabled;
    }
    if (body.default !== undefined) {
      if (typeof body.default !== "string" || !body.default.trim()) {
        return NextResponse.json({ error: "default must be a non-empty string" }, { status: 400 });
      }
      patch.defaultConnection = body.default.trim();
    }
    if (body.connections !== undefined) {
      if (!body.connections || typeof body.connections !== "object" || Array.isArray(body.connections)) {
        return NextResponse.json({ error: "connections must be an object" }, { status: 400 });
      }
      const connections: NonNullable<ImageSettingsPatch["connections"]> = {};
      for (const [id, value] of Object.entries(body.connections as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { enabled?: unknown }).enabled !== "boolean") {
          return NextResponse.json({ error: `connections.${id}.enabled must be a boolean` }, { status: 400 });
        }
        connections[id] = { enabled: (value as { enabled: boolean }).enabled };
      }
      patch.connections = connections;
    }
    const agentDir = getAgentDir();
    const modelRuntime = await ModelRuntime.create();
    writeImageGenerationSettings(patch, agentDir, {
      hasAuth: (provider) => modelRuntime.getProviderAuthStatus(provider).configured,
    });
    return NextResponse.json(await imageSettingsResponse(modelRuntime));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message },
      { status: error instanceof ImageConfigError ? 400 : 500 },
    );
  }
}
