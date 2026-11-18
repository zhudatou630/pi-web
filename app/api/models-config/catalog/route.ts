import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_FILL_BATCH, recommendModelFill, searchModelCatalog } from "@/lib/model-catalog";
import { shippedModels } from "@/lib/model-config-services";
import { loadModelsDevCatalog, MODELS_DEV_URL } from "@/lib/models-dev-catalog";

export const dynamic = "force-dynamic";

// ~800 bytes per row (id, api, URL) is far more than real definitions need.
const MAX_BODY_BYTES = MAX_FILL_BATCH * 800;

/** A string within `max`, "" when absent; null rejects the request (wrong type or too long). */
function field(value: unknown, max: number): string | null {
  if (value === undefined) return "";
  return typeof value === "string" && value.length <= max ? value : null;
}

/** models.dev, plus pi's shipped models when thinking can be matched (it needs the API). */
async function loadSources(needShipped: boolean) {
  return Promise.all([
    loadModelsDevCatalog(),
    // Thinking enrichment only; models.dev still fills the rest without it.
    needShipped ? shippedModels().catch(() => []) : [],
  ]);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").slice(0, 120);
  const provider = (searchParams.get("provider") ?? "").slice(0, 120);
  const baseUrl = (searchParams.get("baseUrl") ?? "").slice(0, 500);
  const api = (searchParams.get("api") ?? "").slice(0, 120);
  const parsedLimit = Number.parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;

  try {
    const [entries, shipped] = await loadSources(Boolean(api));
    const models = searchModelCatalog(entries, query, provider, limit);
    const recommendation = recommendModelFill(entries, shipped, { query, provider, baseUrl, api });
    return NextResponse.json({ models, recommendation, source: MODELS_DEV_URL });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

/** Fill for many models of one provider: `{ provider, models: [{ id, api?, baseUrl? }] }`, answered in order. */
export async function POST(req: Request) {
  let body: { provider?: unknown; models?: unknown } | null;
  try {
    body = await parseJsonWithinLimit(req, MAX_BODY_BYTES) as typeof body;
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: error instanceof RequestBodyTooLargeError ? 413 : 400 });
  }
  const provider = field(body?.provider, 120);
  const requests = Array.isArray(body?.models) && body.models.length <= MAX_FILL_BATCH && provider !== null
    ? body.models.map((model) => {
        const entry = typeof model === "object" && model !== null ? model as Record<string, unknown> : {};
        const query = field(entry.id, 120);
        const baseUrl = field(entry.baseUrl, 500);
        const api = field(entry.api, 120);
        return query === null || baseUrl === null || api === null ? null : { query, provider, baseUrl, api };
      })
    : null;
  if (!requests || requests.some((request) => request === null)) {
    return NextResponse.json({ error: `Send { provider, models: [{ id, api?, baseUrl? }] } with at most ${MAX_FILL_BATCH} models` }, { status: 400 });
  }
  try {
    const valid = requests.filter((request): request is NonNullable<typeof request> => request !== null);
    const [entries, shipped] = await loadSources(valid.some((request) => request.api));
    const recommendations = valid.map((request) => request.query.trim() ? recommendModelFill(entries, shipped, request) : null);
    return NextResponse.json({ recommendations, source: MODELS_DEV_URL });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
