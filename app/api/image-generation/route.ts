import { NextResponse } from "next/server";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  imagePopupView,
  isImageGenerationEnabled,
  resolveImageConfig,
} from "@/lib/image-generation-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const agentDir = getAgentDir();
  if (!isImageGenerationEnabled(agentDir)) return NextResponse.json({ available: false });
  try {
    const config = resolveImageConfig(agentDir);
    if (!config.enabled) return NextResponse.json({ available: false });
    const modelRuntime = await ModelRuntime.create();
    const view = imagePopupView(config, (provider) => modelRuntime.getProviderAuthStatus(provider).configured);
    return NextResponse.json(view.connections.length ? { available: true, config: view } : { available: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
