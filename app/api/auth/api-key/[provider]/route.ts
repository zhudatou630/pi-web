import { createModelsConfigServices, resolveOptionalCwd } from "@/lib/model-config-services";
import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { LLAMA_CPP_PROVIDER_ID } from "@/lib/provider-listing";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isRecord } from "@/lib/model-config-validation";
import { removeStoredCredentialIfType, storeProviderCredential } from "@/lib/provider-credential-store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

// POST /api/auth/api-key/[provider] — llama.cpp also accepts a router URL and optional key.
export async function POST(req: Request, { params }: Params) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const { provider } = await params;
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isRecord(body)) return NextResponse.json({ error: "Expected an object" }, { status: 400 });
  const llama = provider === LLAMA_CPP_PROVIDER_ID;
  const apiKey = body.apiKey ?? "";
  if (typeof apiKey !== "string" || (!llama && !apiKey.trim())) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }
  if (body.cwd !== undefined && body.cwd !== null && typeof body.cwd !== "string") {
    return NextResponse.json({ error: "cwd must be a string" }, { status: 400 });
  }
  let routerUrl: URL | undefined;
  if (llama) {
    try { routerUrl = new URL(typeof body.serverUrl === "string" ? body.serverUrl.trim() : ""); } catch { /* validation below */ }
    if (!routerUrl || !["http:", "https:"].includes(routerUrl.protocol) || routerUrl.username || routerUrl.password) {
      return NextResponse.json({ error: "Enter an http or https llama.cpp router URL without embedded credentials" }, { status: 400 });
    }
  }
  const signal = llama ? AbortSignal.any([req.signal, AbortSignal.timeout(15_000)]) : req.signal;
  try {
    const resolved = await resolveOptionalCwd(body.cwd ?? null);
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    // Composed runtime: a provider registered by an extension is only known to
    // the same runtime chat uses, so its auth methods must come from there too.
    const services = await createModelsConfigServices(resolved.cwd);
    const modelRuntime = services.modelRuntime;
    const apiKeyAuth = modelRuntime.getProvider(provider)?.auth.apiKey;
    if (!apiKeyAuth?.login) {
      throw new Error(`${provider} does not support API key login`);
    }
    let keySubmitted = false;
    let urlSubmitted = false;
    const credential = await apiKeyAuth.login({
      signal,
      notify: () => {},
      prompt: async (prompt) => {
        if (routerUrl && !urlSubmitted && prompt.type === "text") {
          urlSubmitted = true;
          return routerUrl.href;
        }
        if (prompt.type === "select") {
          const keyOption = prompt.options.find((option) => option.id === "api-key" || option.id === "bearer-token");
          if (keyOption) return keyOption.id;
          throw new Error(`${provider} requires interactive authentication setup`);
        }
        if (!keySubmitted && prompt.type === "secret") {
          keySubmitted = true;
          return apiKey.trim();
        }
        throw new Error(`${provider} requires additional authentication settings`);
      },
    });
    // ModelRuntime.login() persists the credential and then performs an
    // unbounded network catalog refresh. Store the returned credential
    // directly so a slow catalog cannot leave the save request hanging.
    await storeProviderCredential(provider, credential);
    invalidateModelsCache();
    if (llama) {
      // A saved credential stays successful even if its catalog refresh fails.
      try {
        const result = await modelRuntime.refresh({ providers: [provider], allowNetwork: true, force: true, signal });
        return NextResponse.json({ success: true, catalog: { completed: !result.aborted && result.errors.size === 0 && process.env.PI_OFFLINE === undefined, modelCount: modelRuntime.getModels(provider).length } });
      } catch {
        return NextResponse.json({ success: true, catalog: { completed: false } });
      } finally {
        invalidateModelsCache();
      }
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/auth/api-key/[provider] — removes stored API key
export async function DELETE(_req: Request, { params }: Params) {
  const { provider } = await params;
  try {
    const removal = await removeStoredCredentialIfType(provider, "api_key");
    if (removal.status === "type_mismatch") {
      return NextResponse.json(
        { error: `${provider} is authenticated with OAuth, not an API key` },
        { status: 409 },
      );
    }
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
