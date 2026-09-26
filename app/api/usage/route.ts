import { NextResponse } from "next/server";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { recommendModelCatalogPreset } from "@/lib/model-catalog";
import { loadModelsDevCatalog } from "@/lib/models-dev-catalog";
import {
  buildUsageRecords,
  cachedSessionUsage,
  startUsageScan,
  type UsagePrice,
  type UsageResponse,
} from "@/lib/usage-stats";
import { resolveProject } from "@/lib/worktree";

export const dynamic = "force-dynamic";

/** A few changed files finish inside this; a cold or upgraded cache answers with progress instead. */
const SCAN_WAIT_MS = 1500;

const priced = (cost: UsagePrice | undefined): cost is UsagePrice =>
  Boolean(cost && (cost.input > 0 || cost.output > 0));

export async function GET() {
  try {
    const scan = startUsageScan();
    // Wait out the stat pass first: a slow first request (module init) must not
    // time out before the scan even knows whether there is anything to index.
    const [finished, runtime, catalog] = await Promise.all([
      scan.planned.then(() => Promise.race([
        scan.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(resolve, SCAN_WAIT_MS, false)),
      ])),
      ModelRuntime.create(),
      loadModelsDevCatalog().catch(() => []),
    ]);

    const sessions = cachedSessionUsage();
    const projects = new Map<string, string>();
    await Promise.all([...new Set(sessions.map((s) => s.cwd))].map(async (cwd) => {
      projects.set(cwd, cwd ? (await resolveProject(cwd)).projectRoot : "");
    }));

    // Current price: pi's own model config (built-ins and models.json), then the
    // same id under any provider, then models.dev.
    const models = runtime.getModels();
    const records = buildUsageRecords(sessions, (provider, model) => {
      const own = runtime.getModel(provider, model)?.cost;
      if (priced(own)) return own;
      const sameId = models.find((m) => m.id === model && priced(m.cost))?.cost;
      if (sameId) return sameId;
      const fromCatalog = recommendModelCatalogPreset(catalog, model, provider).price;
      return fromCatalog.status === "reliable" ? fromCatalog.cost : null;
    }, (cwd) => projects.get(cwd) ?? cwd);

    const body: UsageResponse = { records, scan: finished || scan.total === 0 ? null : { done: scan.done, total: scan.total } };
    return NextResponse.json(body);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
