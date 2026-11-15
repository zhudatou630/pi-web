import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "./thinking-levels";

export const STARTUP_SELECTION_ENTRY = "pi-web:pending-startup-selection";

/** Intent, not the stand-in's clamped model/effort; replayed only while startup is incomplete. */
export interface StartupSelection extends ExplicitStartupPreferences {
  defaultModel: { provider: string; modelId: string } | null;
  enabledModels: string[];
  persistStartupPreferences: boolean;
  allowInitialModelFallback: boolean;
}

export function readPendingStartupSelection(entries: readonly { type: string; customType?: string; data?: unknown }[]): StartupSelection | undefined {
  const data = entries.findLast((entry) => entry.type === "custom" && entry.customType === STARTUP_SELECTION_ENTRY)?.data;
  if (!data || typeof data !== "object") return undefined;
  const value = data as StartupSelection;
  const validModel = (model: unknown): boolean => Boolean(model && typeof model === "object"
    && typeof (model as { provider?: unknown }).provider === "string"
    && typeof (model as { modelId?: unknown }).modelId === "string");
  if ((value.model !== undefined && !validModel(value.model))
    || (value.defaultModel !== null && !validModel(value.defaultModel))
    || (value.thinkingLevel !== undefined && !THINKING_LEVELS.includes(value.thinkingLevel))
    || !Array.isArray(value.enabledModels) || !value.enabledModels.every((pattern) => typeof pattern === "string")
    || typeof value.persistStartupPreferences !== "boolean" || typeof value.allowInitialModelFallback !== "boolean") return undefined;
  return value;
}

export interface ExplicitStartupPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

export interface EffectiveStartupPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel: ThinkingLevel;
  supportsThinking: boolean;
}

/**
 * Persist explicit browser selections without re-running AgentSession setters.
 *
 * The session constructor already records the effective model and thinking
 * level. Calling setModel()/setThinkingLevel() again would append duplicate
 * session entries and emit duplicate extension events.
 */
export async function persistExplicitStartupPreferences(
  settingsManager: SettingsManager,
  explicit: ExplicitStartupPreferences,
  effective: EffectiveStartupPreferences,
): Promise<{ modelDefaultChanged: boolean }> {
  if (!explicit.model && !explicit.thinkingLevel) {
    return { modelDefaultChanged: false };
  }

  let modelDefaultChanged = false;

  if (
    explicit.model
    && effective.model
    && explicit.model.provider === effective.model.provider
    && explicit.model.modelId === effective.model.modelId
  ) {
    settingsManager.setDefaultModelAndProvider(
      effective.model.provider,
      effective.model.modelId,
    );
    modelDefaultChanged = true;
  }

  if (
    explicit.thinkingLevel
    && (effective.supportsThinking || effective.thinkingLevel !== "off")
  ) {
    settingsManager.setDefaultThinkingLevel(effective.thinkingLevel);
  }

  await settingsManager.flush();
  return { modelDefaultChanged };
}
