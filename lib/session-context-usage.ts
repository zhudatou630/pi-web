import {
  getLastAssistantUsage,
  ModelRuntime,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ContextUsage } from "./pi-types";
import type { AgentUsage, SessionEntry } from "./types";

declare global {
  var __piStaticModelRuntime: Promise<ModelRuntime> | undefined;
}

function getSharedModelRuntime(): Promise<ModelRuntime> {
  if (!globalThis.__piStaticModelRuntime) {
    globalThis.__piStaticModelRuntime = ModelRuntime.create().catch((err) => {
      // Allow retry on next call if creation failed
      delete globalThis.__piStaticModelRuntime;
      throw err;
    });
  }
  return globalThis.__piStaticModelRuntime;
}

interface ModelCandidate {
  provider: string;
  modelId: string;
}

function resolveUsageContextTokens(
  usage?: AgentUsage | { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null,
): number {
  if (!usage) return 0;
  if ("totalTokens" in usage && typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
    return usage.totalTokens;
  }
  return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function findActiveModelOnBranch(branchEntries: SessionEntry[]): ModelCandidate | null {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (entry.type === "model_change" && entry.modelId) {
      return {
        provider: entry.provider || "",
        modelId: entry.modelId,
      };
    }
    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.model) {
      return {
        provider: entry.message.provider || "",
        modelId: entry.message.model,
      };
    }
  }
  return null;
}

function getLatestCompaction(branchEntries: SessionEntry[]): SessionEntry | null {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      return branchEntries[i];
    }
  }
  return null;
}

/**
 * Resolve context window for a given provider/modelId.
 * Checks exact match first, then falls back to searching known models by modelId.
 */
export async function resolveModelContextWindow(
  provider: string,
  modelId: string,
  modelRuntime?: ModelRuntime,
): Promise<number> {
  if (!modelId) return 0;
  try {
    const runtime = modelRuntime ?? (await getSharedModelRuntime());
    const exact = runtime.getModel(provider, modelId);
    if (exact?.contextWindow && exact.contextWindow > 0) {
      return exact.contextWindow;
    }

    const all = runtime.getModels();
    // 1. Match exact modelId across all providers
    const matched = all.find((m) => m.id === modelId && m.contextWindow > 0);
    if (matched?.contextWindow) return matched.contextWindow;

    // 2. Match trailing name (e.g. google/gemini-3.8-flash vs gemini-3.8-flash)
    const trailing = all.find(
      (m) =>
        (m.id.endsWith(`/${modelId}`) || modelId.endsWith(`/${m.id}`)) &&
        m.contextWindow > 0,
    );
    if (trailing?.contextWindow) return trailing.contextWindow;

    // 3. Fallback heuristic for standard models if runtime lacks custom provider definition
    const lowerId = modelId.toLowerCase();
    if (lowerId.includes("gemini")) return 1_048_576;
    if (lowerId.includes("claude-3-7") || lowerId.includes("claude-sonnet-4") || lowerId.includes("claude-opus-4")) {
      return lowerId.includes("opus-4-6") || lowerId.includes("sonnet-4-6") ? 1_000_000 : 200_000;
    }
    if (lowerId.includes("gpt-4o") || lowerId.includes("o1") || lowerId.includes("o3")) return 128_000;
    if (lowerId.includes("deepseek")) return 64_000;
  } catch {
    // Ignore runtime failure and proceed
  }
  return 0;
}

/**
 * Compute context window usage for a session branch without requiring an active RPC wrapper.
 */
export async function computeSessionContextUsage(
  smOrEntries: SessionManager | SessionEntry[] | { getBranch?: (leafId?: string | null) => unknown; getEntries?: () => unknown },
  leafId?: string | null,
  modelRuntime?: ModelRuntime,
): Promise<ContextUsage | null> {
  try {
    let branchEntries: SessionEntry[];

    if (Array.isArray(smOrEntries)) {
      const entries = smOrEntries;
      if (leafId) {
        const entryMap = new Map<string, SessionEntry>();
        for (const e of entries) {
          if ("id" in e && typeof e.id === "string") entryMap.set(e.id, e);
        }
        const branch: SessionEntry[] = [];
        let currentId: string | null | undefined = leafId;
        while (currentId) {
          const e = entryMap.get(currentId);
          if (!e) break;
          branch.push(e);
          currentId = "parentId" in e ? (e.parentId as string | null | undefined) : undefined;
        }
        branch.reverse();
        branchEntries = branch;
      } else {
        branchEntries = entries;
      }
    } else if ("getBranch" in smOrEntries && typeof smOrEntries.getBranch === "function") {
      branchEntries = (leafId ? smOrEntries.getBranch(leafId) : smOrEntries.getBranch()) as SessionEntry[];
    } else if ("getEntries" in smOrEntries && typeof smOrEntries.getEntries === "function") {
      branchEntries = (smOrEntries.getEntries() ?? []) as SessionEntry[];
    } else {
      branchEntries = [];
    }

    if (branchEntries.length === 0) return null;

    const activeModel = findActiveModelOnBranch(branchEntries);
    const contextWindow = activeModel
      ? await resolveModelContextWindow(activeModel.provider, activeModel.modelId, modelRuntime)
      : 0;

    // After compaction, assistant usage before compaction is stale
    const compactionEntry = getLatestCompaction(branchEntries);
    if (compactionEntry) {
      const compactionIdx = branchEntries.lastIndexOf(compactionEntry);
      let hasPostCompactionUsage = false;
      for (let i = branchEntries.length - 1; i > compactionIdx; i--) {
        const e = branchEntries[i];
        if (e.type === "message" && e.message.role === "assistant") {
          const usage = e.message.usage;
          if (usage && resolveUsageContextTokens(usage) > 0) {
            hasPostCompactionUsage = true;
            break;
          }
        }
      }
      if (!hasPostCompactionUsage) {
        return contextWindow > 0
          ? { tokens: null, contextWindow, percent: null }
          : null;
      }
    }

    // Cast for getLastAssistantUsage which expects pi-coding-agent entry types
    const lastUsage = getLastAssistantUsage(branchEntries as never);
    const tokens = lastUsage ? resolveUsageContextTokens(lastUsage) : null;

    if (tokens === null && contextWindow <= 0) {
      return null;
    }

    const percent =
      tokens !== null && contextWindow > 0
        ? Math.min(100, Math.round((tokens / contextWindow) * 1000) / 10)
        : null;

    return {
      tokens,
      contextWindow,
      percent,
    };
  } catch {
    return null;
  }
}
