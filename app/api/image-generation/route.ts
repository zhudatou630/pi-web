import { NextResponse } from "next/server";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  imagePopupView,
  isImageGenerationEnabled,
  isImageProjectDisabled,
  resolveImageConfig,
} from "@/lib/image-generation-config";
import { projectRootForRequest } from "@/lib/project-feature-switch";

export const dynamic = "force-dynamic";

// GET /api/image-generation?cwd= — whether the composer shows the image button for this project.
export async function GET(req: Request) {
  const agentDir = getAgentDir();
  if (!isImageGenerationEnabled(agentDir)) return NextResponse.json({ available: false });
  try {
    const cwd = new URL(req.url).searchParams.get("cwd");
    if (cwd && isImageProjectDisabled(agentDir, await projectRootForRequest(cwd).catch(() => cwd))) {
      return NextResponse.json({ available: false });
    }
    const config = resolveImageConfig(agentDir);
    if (!config.enabled) return NextResponse.json({ available: false });
    const modelRuntime = await ModelRuntime.create();
    const view = imagePopupView(config, (provider) => modelRuntime.getProviderAuthStatus(provider).configured);
    return NextResponse.json(view.connections.length ? { available: true, config: view } : { available: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
