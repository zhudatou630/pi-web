import { createModelsConfigServices, resolveOptionalCwd } from "@/lib/model-config-services";
import { buildApiKeyProviderList, buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";

export const dynamic = "force-dynamic";

/**
 * Providers that declare an OAuth login method, including anthropic
 * (Claude Pro/Max) — see lib/provider-listing.ts (#309).
 *
 * Uses the same composed runtime as chat (`/api/models`) so package and
 * project extensions that register providers are described with the auth
 * methods they really have. A plain `ModelRuntime.create()` sees only
 * user-level providers and reported e.g. extension-registered OAuth providers
 * as API-key providers whose "save key" call then fails.
 */
export async function GET(req: Request) {
  const resolved = await resolveOptionalCwd(new URL(req.url).searchParams.get("cwd"));
  if ("error" in resolved) {
    return Response.json({ error: resolved.error }, { status: resolved.status });
  }

  const services = await createModelsConfigServices(resolved.cwd);
  const inputs = await collectProviderListingInputs(services.modelRuntime);
  const oauthProviders = buildOAuthProviderList(inputs);
  const apiKeyProviders = buildApiKeyProviderList(inputs);
  return Response.json({ providers: oauthProviders, oauthProviders, apiKeyProviders });
}
