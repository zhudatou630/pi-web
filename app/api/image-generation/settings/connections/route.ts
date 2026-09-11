import { NextResponse } from "next/server";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  ImageConfigError,
  imageSettingsApiResponse,
  isImageProviderConfigured,
  removeImageCustomConnection,
  renameImageConnection,
  upsertImageCustomConnection,
} from "@/lib/image-generation-config";

export const dynamic = "force-dynamic";

async function settingsResponse() {
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create();
  return imageSettingsApiResponse(agentDir, {
    hasAuth: (provider) => modelRuntime.getProviderAuthStatus(provider).configured,
    providerName: (id) => modelRuntime.getProvider(id)?.name ?? id,
  });
}

function textField(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json(
    { error: message },
    { status: error instanceof ImageConfigError ? 400 : 500 },
  );
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { label?: unknown; provider?: unknown; model?: unknown };
    const label = textField(body.label);
    const provider = textField(body.provider);
    const model = textField(body.model);
    if (!label || !provider || !model) {
      return NextResponse.json({ error: "label, provider, and model are required" }, { status: 400 });
    }
    const agentDir = getAgentDir();
    if (!isImageProviderConfigured(agentDir, provider)) {
      return NextResponse.json({ error: "provider must reference a provider configured in models.json" }, { status: 400 });
    }
    upsertImageCustomConnection({ label, provider, model }, agentDir);
    return NextResponse.json(await settingsResponse());
  } catch (error) {
    return errorResponse(error);
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
    const body = await req.json() as { id?: unknown; label?: unknown; provider?: unknown; model?: unknown };
    const id = textField(body.id);
    const label = textField(body.label);
    const provider = textField(body.provider);
    const model = textField(body.model);
    if (!id || !label) {
      return NextResponse.json({ error: "id and label are required" }, { status: 400 });
    }
    if (provider || model) {
      if (!provider || !model) {
        return NextResponse.json({ error: "provider and model are required together" }, { status: 400 });
      }
      const agentDir = getAgentDir();
      if (!isImageProviderConfigured(agentDir, provider)) {
        return NextResponse.json({ error: "provider must reference a provider configured in models.json" }, { status: 400 });
      }
      upsertImageCustomConnection({ id, label, provider, model }, agentDir);
    } else {
      renameImageConnection(id, label, getAgentDir());
    }
    return NextResponse.json(await settingsResponse());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { id?: unknown };
    const id = textField(body.id);
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    removeImageCustomConnection(id, getAgentDir());
    return NextResponse.json(await settingsResponse());
  } catch (error) {
    return errorResponse(error);
  }
}
