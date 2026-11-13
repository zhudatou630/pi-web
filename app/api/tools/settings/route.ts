import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readToolSettings, writeBuiltinTools, writePowerShellToolEnabled } from "@/lib/powershell-settings";
import { SETTINGS_BUILTIN_TOOLS } from "@/lib/tool-presets";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readToolSettings());
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
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || ("enabled" in body) === ("builtinTools" in body)) {
    return NextResponse.json({ error: "Send either enabled or builtinTools" }, { status: 400 });
  }
  if ("builtinTools" in body) {
    if (!Array.isArray(body.builtinTools) || !body.builtinTools.every((name) => typeof name === "string" && SETTINGS_BUILTIN_TOOLS.includes(name))) {
      return NextResponse.json({ error: "builtinTools must contain only built-in tool names" }, { status: 400 });
    }
  } else {
    if (!("enabled" in body) || typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    if (process.platform !== "win32") {
      return NextResponse.json({ error: "PowerShell tool settings are only available on Windows" }, { status: 404 });
    }
  }
  try {
    if ("builtinTools" in body) await writeBuiltinTools(body.builtinTools as string[]);
    else await writePowerShellToolEnabled((body as { enabled: boolean }).enabled);
    return NextResponse.json(await readToolSettings());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
