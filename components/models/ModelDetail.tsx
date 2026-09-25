"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ModelCatalogPreset, ModelCatalogRecommendation } from "@/lib/model-catalog";
import {
  hasModelCostDraftValue,
  modelCostToDraft,
  parseCompleteModelCost,
  setCompatBool,
  type ModelCostDraft,
  type ModelCostKey,
} from "../models-config-helpers";
import {
  ConfigButton,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigField,
} from "../SettingsUi";
import { HeaderListEditor, Hint, Notice, NumInput, SectionHeading, Select, SwitchRow, TextInput, ThinkingLevelMapEditor } from "./fields";
import { API_OPTIONS, type ModelEntry, type ProviderEntry } from "./types";

type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

type ModelCatalogState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; recommendation: ModelCatalogRecommendation; appliedCount: number }
  | { phase: "error"; message: string };

const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const;

function hasDeepseekCompat(model: ModelEntry): boolean {
  return model.compat?.thinkingFormat === "deepseek";
}

function setDeepseekCompat(model: ModelEntry, enabled: boolean): ModelEntry {
  if (enabled) {
    return { ...model, compat: { ...(model.compat ?? {}), ...DEEPSEEK_COMPAT } };
  }
  if (!model.compat) return model;
  const rest = { ...model.compat };
  delete rest.thinkingFormat;
  delete rest.requiresReasoningContentOnAssistantMessages;
  return { ...model, compat: Object.keys(rest).length ? rest : undefined };
}

// Compat can be configured at the provider or model level; provider-composer
// merges them (model wins) at runtime. The UI reads the effective value so
// hand-edited models.json settings are reflected correctly, while toggles
// write to the model entry so a per-model override is explicit.
function effectiveCompat(provider: ProviderEntry, model: ModelEntry): Record<string, unknown> {
  return { ...(provider.compat ?? {}), ...(model.compat ?? {}) };
}

function fillEmptyModelFields(
  model: ModelEntry,
  preset: ModelCatalogPreset,
): { model: ModelEntry; appliedCount: number } {
  const next = { ...model };
  let appliedCount = 0;
  if (!model.name?.trim() && preset.name) {
    next.name = preset.name;
    appliedCount += 1;
  }
  if (model.reasoning === undefined && preset.reasoning === true) {
    next.reasoning = true;
    appliedCount += 1;
  }
  if (!model.input?.length && preset.input?.length) {
    next.input = [...preset.input];
    appliedCount += 1;
  }
  if (model.contextWindow === undefined && preset.contextWindow !== undefined) {
    next.contextWindow = preset.contextWindow;
    appliedCount += 1;
  }
  if (model.maxTokens === undefined && preset.maxTokens !== undefined) {
    next.maxTokens = preset.maxTokens;
    appliedCount += 1;
  }

  if (preset.cost) {
    const cost = { ...(model.cost ?? {}) };
    let filledCostCount = 0;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (cost[key] === undefined && preset.cost[key] !== undefined) {
        cost[key] = preset.cost[key];
        filledCostCount += 1;
      }
    }
    const completeCost = parseCompleteModelCost(modelCostToDraft(cost));
    if (filledCostCount > 0 && completeCost) {
      next.cost = { ...cost, ...completeCost };
      appliedCount += filledCostCount;
    }
  }
  return { model: next, appliedCount };
}

export function ModelDetail({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
  lockId = false,
  cwd = null,
  shadowsBuiltIn = false,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  onChange: (m: ModelEntry) => void;
  onDelete?: () => void;
  lockId?: boolean;
  cwd?: string | null;
  /** This definition's id is a shipped model, which it replaces whole. */
  shadowsBuiltIn?: boolean;
}) {
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const { t } = useI18n();
  const [catalogState, setCatalogState] = useState<ModelCatalogState>({ phase: "idle" });
  const [costEditing, setCostEditing] = useState(false);
  const [costDraft, setCostDraft] = useState<ModelCostDraft>(() => modelCostToDraft(model.cost));
  const costDraftRef = useRef(costDraft);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const catalogRequestIdRef = useRef(0);
  const catalogUndoRef = useRef<ModelEntry | null>(null);
  const costTemplateRef = useRef(model.cost);
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  // `api` is part of a model definition. On a catalog model the editor writes
  // `modelOverrides`, where the SDK ignores `api`, so only offer the field when
  // this really is a definition (`lockId` marks the runtime-override editor).
  const canEditApi = !lockId;
  const setCost = (key: ModelCostKey, value: string) => {
    const nextDraft = { ...costDraftRef.current, [key]: value };
    const completeCost = parseCompleteModelCost(nextDraft);
    const nextModel = { ...model };
    costDraftRef.current = nextDraft;
    setCostDraft(nextDraft);
    if (completeCost) {
      nextModel.cost = { ...(costTemplateRef.current ?? {}), ...completeCost };
      costTemplateRef.current = nextModel.cost;
    } else {
      delete nextModel.cost;
    }
    onChange(nextModel);
  };
  const toggleCostEditing = () => {
    if (costEditing) {
      setCostEditing(false);
      return;
    }
    costTemplateRef.current = model.cost;
    const nextDraft = modelCostToDraft(model.cost);
    costDraftRef.current = nextDraft;
    setCostDraft(nextDraft);
    setCostEditing(true);
  };
  const testSummary = (() => {
    if (testState.phase === "idle" || testState.phase === "testing") return null;
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
      return [t("i18n.connected"), ...meta, testState.responseText || null].filter(Boolean).join(" · ");
    }
    return [t("i18n.failed"), ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  useEffect(() => {
    setTestState({ phase: "idle" });
  }, [providerName, provider.baseUrl, provider.api, provider.apiKey, model.id, model.api]);

  useEffect(() => {
    catalogRequestIdRef.current += 1;
    setCatalogState({ phase: "idle" });
    catalogUndoRef.current = null;
  }, [providerName, provider.baseUrl, model.id]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider, model, cwd: cwd ?? undefined }),
      });
      const d = await res.json() as {
        ok?: boolean;
        error?: string;
        latencyMs?: number;
        status?: number;
        responseText?: string;
      };
      if (!res.ok || !d.ok) {
        setTestState({
          phase: "error",
          message: d.error ?? `HTTP ${res.status}`,
          latencyMs: d.latencyMs,
          status: d.status,
        });
        return;
      }
      setTestState({
        phase: "success",
        latencyMs: d.latencyMs,
        status: d.status,
        responseText: d.responseText,
      });
    } catch (e) {
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [model, provider, providerName, testState.phase, cwd]);

  const handleCatalogFill = useCallback(async () => {
    const query = model.id.trim();
    if (!query || catalogState.phase === "loading") return;
    const requestId = ++catalogRequestIdRef.current;
    setCatalogState({ phase: "loading" });
    try {
      const params = new URLSearchParams({ q: query, provider: providerName, limit: "50" });
      if (cwd) params.set("cwd", cwd);
      if (provider.baseUrl?.trim()) params.set("baseUrl", provider.baseUrl.trim());
      const res = await fetch(`/api/models-config/catalog?${params}`);
      const data = await res.json() as { recommendation?: ModelCatalogRecommendation; error?: string };
      if (requestId !== catalogRequestIdRef.current) return;
      if (!res.ok || data.error || !data.recommendation) {
        setCatalogState({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      const filled = fillEmptyModelFields(model, data.recommendation.preset);
      if (filled.appliedCount > 0) {
        catalogUndoRef.current = model;
        onChange(filled.model);
      }
      setCostEditing(false);
      setCatalogState({
        phase: "success",
        recommendation: data.recommendation,
        appliedCount: filled.appliedCount,
      });
    } catch (error) {
      if (requestId !== catalogRequestIdRef.current) return;
      setCatalogState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [catalogState.phase, model, onChange, provider.baseUrl, providerName, cwd]);

  const undoCatalogFill = () => {
    const previous = catalogUndoRef.current;
    if (!previous) return;
    catalogUndoRef.current = null;
    onChange(previous);
    setCatalogState({ phase: "idle" });
  };

  const catalogResultSummary = (() => {
    if (catalogState.phase !== "success") return null;
    const { recommendation, appliedCount } = catalogState;
    const applied = appliedCount > 0
      ? t("models.catalogFilled", { count: appliedCount })
      : t("models.catalogNoEmptyFields");
    if (recommendation.price.status === "unreliable") {
      const price = recommendation.price.reason === "no-exact-match"
        ? t("models.catalogNoExactMatch")
        : t("models.catalogPriceUnreliable");
      return `${applied} · ${price}`;
    }
    const price = recommendation.price.method === "provider"
      ? t("models.catalogPriceProvider", { provider: recommendation.price.providerName ?? recommendation.price.providerId ?? providerName })
      : recommendation.price.method === "base-url"
        ? t("models.catalogPriceBaseUrl", { provider: recommendation.price.providerName ?? recommendation.price.providerId ?? providerName })
        : t("models.catalogPriceConsensus", {
            support: recommendation.price.support,
            total: recommendation.price.total,
          });
    return `${applied} · ${price}`;
  })();
  const catalogStatusText = catalogState.phase === "error"
    ? catalogState.message
    : catalogResultSummary;
  const catalogTone = catalogState.phase === "error"
    ? "danger"
    : catalogState.phase === "success" && catalogState.recommendation.price.status === "unreliable"
      ? "warning"
      : "info";
  const costFields = [
    { key: "input", label: t("models.costInput") },
    { key: "output", label: t("models.costOutput") },
    { key: "cacheRead", label: t("models.costCacheRead") },
    { key: "cacheWrite", label: t("models.costCacheWrite") },
  ] as const;
  const formatCost = (key: ModelCostKey): string => {
    const value = model.cost?.[key];
    return value === undefined ? t("models.notProvided") : `$${String(value)}`;
  };
  const remainingCompatKeys = new Set(Object.keys(model.compat ?? {}));
  let compatibilityOverrideCount = 0;
  if (hasDeepseekCompat(model)) {
    compatibilityOverrideCount += 1;
    remainingCompatKeys.delete("thinkingFormat");
    remainingCompatKeys.delete("requiresReasoningContentOnAssistantMessages");
  }
  if (Object.prototype.hasOwnProperty.call(model.compat ?? {}, "supportsDeveloperRole")) {
    compatibilityOverrideCount += 1;
    remainingCompatKeys.delete("supportsDeveloperRole");
  }
  compatibilityOverrideCount += remainingCompatKeys.size;
  const advancedSummaryParts = [
    model.api ? `API: ${model.api}` : null,
    Object.keys(model.headers ?? {}).length
      ? t("models.headersSummary", { count: Object.keys(model.headers ?? {}).length })
      : null,
    compatibilityOverrideCount
      ? t("models.compatSummary", { count: compatibilityOverrideCount })
      : null,
    Object.keys(model.thinkingLevelMap ?? {}).length
      ? t("models.thinkingSummary", { count: Object.keys(model.thinkingLevelMap ?? {}).length })
      : null,
  ].filter((part): part is string => Boolean(part));
  const advancedSummary = advancedSummaryParts.length
    ? advancedSummaryParts.join(" · ")
    : t("models.providerDefaults");

  return (
    <div className="models-form">
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <div className="models-title-block">
            <strong className="models-title">{model.name || model.id || t("models.untitledModel")}</strong>
            <span className="models-subtitle">
              <span className="models-tag">{lockId ? t("models.kindOverride") : t("models.kindDefinition")}</span>
              {lockId ? t("models.overrideHint") : t("models.definitionHint")}
            </span>
          </div>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <ConfigButton
            size="small"
            onClick={handleTest}
            disabled={!model.id.trim() || testState.phase === "testing"}
            title={t("i18n.testConnection")}
          >
            {testState.phase === "testing" ? t("i18n.checking") : t("i18n.testConnection")}
          </ConfigButton>
          {onDelete && (
            <ConfigButton size="small" variant="ghost" className="models-danger-ghost" onClick={onDelete}>{t("models.deleteDefinition")}</ConfigButton>
          )}
        </ConfigDetailActions>
      </ConfigDetailHeader>

      {shadowsBuiltIn && onDelete && (
        <Notice
          tone="warning"
          action={<ConfigButton size="small" onClick={onDelete}>{t("models.restoreBuiltIn")}</ConfigButton>}
        >
          {t("models.replacesBuiltInHint")}
        </Notice>
      )}

      {testSummary && (
        <Notice tone={testState.phase === "success" ? "success" : "danger"}>
          <span className="models-ellipsis" title={testSummary}>{testSummary}</span>
        </Notice>
      )}

      <div className="models-form-grid">
        <ConfigField label={t("models.modelId")}><TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono disabled={lockId} /></ConfigField>
        <ConfigField label={t("models.displayName")}><TextInput value={model.name ?? ""} onChange={(v) => set("name", v || undefined)} placeholder={model.id || t("models.displayName")} /></ConfigField>
      </div>

      <div className="models-catalog-row">
        <ConfigButton
          size="small"
          onClick={() => void handleCatalogFill()}
          disabled={!model.id.trim() || catalogState.phase === "loading"}
        >
          {catalogState.phase === "loading" ? t("models.catalogFilling") : t("models.catalogFill")}
        </ConfigButton>
        <a href="https://github.com/anomalyco/models.dev" target="_blank" rel="noreferrer" className="models-hint models-push-right">
          {t("models.catalogSource")}
        </a>
      </div>
      {catalogStatusText && (
        <Notice
          tone={catalogTone}
          action={catalogUndoRef.current && (
            <ConfigButton size="small" variant="ghost" onClick={undoCatalogFill}>{t("models.catalogUndo")}</ConfigButton>
          )}
        >
          <span className="models-ellipsis" title={catalogStatusText}>{catalogStatusText}</span>
        </Notice>
      )}

      <section className="models-section">
        <SectionHeading title={t("models.capabilities")} />
        <div className="models-switch-list">
          <SwitchRow label={t("models.reasoning")} checked={model.reasoning ?? false} onChange={(v) => set("reasoning", v || undefined)} />
          <SwitchRow label={t("models.imageInput")} checked={model.input?.includes("image") ?? false}
            onChange={(v) => set("input", v ? ["text", "image"] : undefined)} />
        </div>
      </section>

      <section className="models-section">
        <SectionHeading title={t("models.modelSpecs")} />
        <div className="models-form-grid">
          <ConfigField label={t("models.contextWindow")}>
            <NumInput value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
              onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)} placeholder="128000" />
          </ConfigField>
          <ConfigField label={t("models.maxOutputTokens")}>
            <NumInput value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
              onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)} placeholder="16384" />
          </ConfigField>
        </div>

        <div className="models-section-header">
          <span className="config-field-label">{t("models.costPerMillion")}</span>
          <ConfigButton size="small" variant="ghost" onClick={toggleCostEditing} aria-expanded={costEditing}>
            {costEditing ? t("models.finishEditingCosts") : t("models.editCosts")}
          </ConfigButton>
        </div>
        {costEditing ? (
          <div className="models-cost-grid">
            {costFields.map(({ key, label }) => (
              <ConfigField key={key} label={label}>
                <NumInput value={costDraft[key]} onChange={(v) => setCost(key, v)} placeholder="0" />
              </ConfigField>
            ))}
            {hasModelCostDraftValue(costDraft) && !parseCompleteModelCost(costDraft) && (
              <p aria-live="polite" className="models-hint is-warning models-grid-full">
                {t("models.costAllRequired")}
              </p>
            )}
          </div>
        ) : (
          <div className="models-cost-grid">
            {costFields.map(({ key, label }) => (
              <div key={key} className="models-cost-cell">
                <span className="models-hint">{label}</span>
                <span className={`models-cost-value${model.cost?.[key] === undefined ? " is-missing" : ""}`}>{formatCost(key)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="models-section">
        <button
          type="button"
          className="models-disclosure"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          aria-controls="model-advanced-settings"
        >
          <span className="models-disclosure-copy">
            <strong>{t("models.advancedSettings")}</strong>
            <span>{advancedSummary}</span>
          </span>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="models-disclosure-chevron">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {advancedOpen && (
          <div id="model-advanced-settings" className="models-form">
            {canEditApi && (
              <ConfigField label={t("models.apiOverride")}>
                <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
              </ConfigField>
            )}

            <ConfigField label={t("models.headers")}>
              <HeaderListEditor
                headers={model.headers}
                onChange={(headers) => set("headers", headers)}
              />
              <Hint>{t("models.headersHelp")}</Hint>
            </ConfigField>

            {model.reasoning && (
              <>
                <SectionHeading title={t("models.compatibility")} />
                <div className="models-switch-list">
                  <SwitchRow
                    label={t("models.deepSeekThinkingCompat")}
                    checked={hasDeepseekCompat(model)}
                    onChange={(v) => onChange(setDeepseekCompat(model, v))}
                  />
                  <SwitchRow
                    label={t("models.developerRole")}
                    checked={effectiveCompat(provider, model)["supportsDeveloperRole"] !== false}
                    onChange={(v) => onChange(setCompatBool(model, "supportsDeveloperRole", v))}
                  />
                </div>
                <SectionHeading
                  title={t("models.thinkingLevelMap")}
                  actions={model.thinkingLevelMap && (
                    <ConfigButton size="small" variant="ghost" onClick={() => set("thinkingLevelMap", undefined)}>
                      {t("models.clearAll")}
                    </ConfigButton>
                  )}
                />
                <ThinkingLevelMapEditor
                  value={model.thinkingLevelMap}
                  onChange={(v) => set("thinkingLevelMap", v)}
                />
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
