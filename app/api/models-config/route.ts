import { NextResponse } from "next/server";
import { InvalidProviderEntryError } from "@/lib/model-config-validation";
import { ModelsConfigReadError, readModelsConfigResult, writeModelsConfig } from "@/lib/models-config-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const { config, error } = readModelsConfigResult();
  return NextResponse.json(error ? { ...config, error } : config);
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    writeModelsConfig(body);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof InvalidProviderEntryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: "Failed to read ~/.pi/agent/models.json" }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
