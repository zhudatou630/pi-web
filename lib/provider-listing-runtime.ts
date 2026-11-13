import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildOAuthProviderList, providerDisplayName, type ProviderCredentialType, type ProviderListingInput } from "@/lib/provider-listing";
import { isRecord } from "@/lib/model-config-validation";

/**
 * Adapter between `ModelRuntime` and the pure listing helpers in
 * `lib/provider-listing.ts`.
 */
export async function collectProviderListingInputs(
  modelRuntime: ModelRuntime,
): Promise<ProviderListingInput[]> {
  const models = modelRuntime.getModels();

  const credentialTypes = new Map<string, ProviderCredentialType>();
  try {
    for (const credential of await modelRuntime.listCredentials()) {
      if (credential.type === "api_key" || credential.type === "oauth") {
        credentialTypes.set(credential.providerId, credential.type);
      }
    }
  } catch {
    // A damaged auth.json must not empty the provider list; fall back to the
    // per-provider auth status only.
  }

  const modelCounts = new Map<string, number>();
  for (const model of models) modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);

  return modelRuntime.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    hasApiKeyLogin: Boolean(provider.auth.apiKey?.login),
    hasOAuth: Boolean(provider.auth.oauth),
    ...(provider.auth.oauth?.name ? { oauthName: provider.auth.oauth.name } : {}),
    status: modelRuntime.getProviderAuthStatus(provider.id),
    ...(credentialTypes.has(provider.id)
      ? { credentialType: credentialTypes.get(provider.id) }
      : {}),
    modelCount: modelCounts.get(provider.id) ?? 0,
  }));
}

/** Same name precedence as the Models editor, including a models.json display name. */
export function providerDisplayNames(inputs: ProviderListingInput[], definitions: unknown): Record<string, string> {
  const oauth = new Map(buildOAuthProviderList(inputs).map((provider) => [provider.id, provider.name]));
  return Object.fromEntries(inputs.map((provider) => {
    const definition = isRecord(definitions) ? definitions[provider.id] : undefined;
    return [provider.id, providerDisplayName(provider.id,
      isRecord(definition) && typeof definition.name === "string" ? definition.name : undefined,
      oauth.get(provider.id), provider.name)];
  }));
}
