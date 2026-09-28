import { NextResponse } from "next/server";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  imagePopupView,
  isImageGenerationEnabled,
  isImageGenerationEnabledForProject,
  resolveImageConfig,
} from "@/lib/image-generation-config";
import { projectRootForRequest } from "@/lib/project-feature-switch";

export const dynamic = "force-dynamic";

// GET /api/image-generation?cwd= — whether the composer shows the image button for this project.
export async function GET(req: Request) {
  const agentDir = getAgentDir();
  try {
    const cwd = new URL(req.url).searchParams.get("cwd");
    // A visibility hint only; executeImageGeneration() enforces the switch.
    const projectRoot = cwd ? await projectRootForRequest(cwd).catch(() => cwd) : undefined;
    const enabled = projectRoot === undefined
      ? isImageGenerationEnabled(agentDir)
      : isImageGenerationEnabledForProject(agentDir, projectRoot);
    if (!enabled) return NextResponse.json({ available: false });
    const config = resolveImageConfig(agentDir, projectRoot);
    if (!config.enabled) return NextResponse.json({ available: false });
    const modelRuntime = await ModelRuntime.create();
    const view = imagePopupView(config, (provider) => modelRuntime.getProviderAuthStatus(provider).configured);
    return NextResponse.json(view.connections.length ? { available: true, config: view } : { available: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
