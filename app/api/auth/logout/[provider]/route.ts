import { createModelsConfigServices, resolveOptionalCwd } from "@/lib/model-config-services";
import { clearExactEnabledModelsForProvider } from "@/lib/enabled-models-disconnect";
import { invalidateModelsCache } from "@/lib/models-cache";
import { removeStoredCredentialIfType } from "@/lib/provider-credential-store";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const body = await req.json().catch(() => ({})) as { cwd?: string };
  const resolved = await resolveOptionalCwd(body.cwd ?? null);
  if ("error" in resolved) {
    return Response.json({ error: resolved.error }, { status: resolved.status });
  }
  const services = await createModelsConfigServices(resolved.cwd);
  if (!services.modelRuntime.getProvider(provider)?.auth.oauth) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }
  const removal = await removeStoredCredentialIfType(provider, "oauth");
  if (removal.status === "type_mismatch") {
    return Response.json({ error: `${provider} is authenticated with an API key, not OAuth` }, { status: 409 });
  }
  try {
    await clearExactEnabledModelsForProvider(provider);
  } catch {
    // Credential is already gone; leftover picker entries only resurface as a warning.
  }
  invalidateModelsCache();
  return Response.json({ ok: true });
}
