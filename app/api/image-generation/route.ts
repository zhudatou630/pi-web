import { existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { IMAGE_CONFIG_FILE, imageConfigView, readImageConfig } from "@/lib/image-generation-config";

export async function GET() {
  const agentDir = getAgentDir();
  if (!existsSync(path.join(agentDir, IMAGE_CONFIG_FILE))) return NextResponse.json({ available: false });
  try {
    return NextResponse.json({ available: true, config: imageConfigView(readImageConfig(agentDir)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}