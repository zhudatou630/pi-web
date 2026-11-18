"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ModelCatalogRecommendation } from "@/lib/model-catalog";
import { THINKING_LEVEL_LABELS, THINKING_LEVELS } from "@/lib/thinking-levels";
import {
  compatBoolChoice,
  deepseekThinkingChoice,
  effectiveCompat,
  applyCatalogPreset,
  formatSamplingParams,
  hasModelCostDraftValue,
  modelCostToDraft,
  parseCompleteModelCost,
  parseSamplingParamsDraft,
  SAMPLING_PARAMS_APIS,
  setCompatBool,
  setCompatBoolChoice,
  setDeepseekThinkingChoice,
  THINKING_COMPAT_KEYS,
  thinkingLevelState,
  type ModelCostDraft,
  type ModelCostKey,
} from "../models-config-helpers";
import {
  ConfigButton,
  ConfigField,
  SettingsGroup,
  SettingsRow,
} from "../SettingsUi";
import { CompatChoiceRow, HeaderListEditor, Notice, NumInput, SectionHeading, Select, SwitchRow, TextInput, ThinkingLevelMapEditor } from "./fields";
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

/** APIs whose request builders choose between the developer and system role. */
const DEVELOPER_ROLE_APIS = new Set(["openai-completions", "openai-responses", "azure-openai-responses"]);

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
  const [thinkingEditing, setThinkingEditing] = useState(false);
  const [costDraft, setCostDraft] = useState<ModelCostDraft>(() => modelCostToDraft(model.cost));
  const costDraftRef = useRef(costDraft);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Local text keeps the user's formatting; it resyncs only when the model's
  // value changes from elsewhere (discard, catalog undo).
  const [samplingText, setSamplingText] = useState(() => formatSamplingParams(model.samplingParams));
  const samplingShown = JSON.stringify(parseSamplingParamsDraft(samplingText)) === JSON.stringify(model.samplingParams)
    ? samplingText
    : formatSamplingParams(model.samplingParams);
  const samplingInvalid = typeof model.samplingParams === "string";
  const effectiveApi = model.api || provider.api;
  const samplingApiSupported = effectiveApi ? (SAMPLING_PARAMS_APIS as readonly string[]).includes(effectiveApi) : undefined;
  const testRequestIdRef = useRef(0);
  const effectiveBaseUrl = model.baseUrl ?? provider.baseUrl;
  const catalogRequestIdRef = useRef(0);
  const catalogUndoRef = useRef<ModelEntry | null>(null);
  // Fill applies to the draft as it is when the lookup returns, not when it started.
  const modelRef = useRef(model);
  useEffect(() => { modelRef.current = model; });
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

  // Keyed by content: the parent rebuilds identical provider/model objects on unrelated renders.
  const testDraftKey = JSON.stringify([providerName, provider, model, cwd]);
  useEffect(() => {
    testRequestIdRef.current += 1;
    setTestState({ phase: "idle" });
    return () => { testRequestIdRef.current += 1; };
  }, [testDraftKey]);

  useEffect(() => {
    catalogRequestIdRef.current += 1;
    setCatalogState({ phase: "idle" });
    catalogUndoRef.current = null;
  }, [providerName, effectiveBaseUrl, effectiveApi, model.id]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    if (typeof model.samplingParams === "string") {
      setTestState({ phase: "error", message: t("models.samplingParamsInvalid") });
      return;
    }
    const requestId = ++testRequestIdRef.current;
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
      if (requestId !== testRequestIdRef.current) return;
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
      if (requestId !== testRequestIdRef.current) return;
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [model, provider, providerName, testState.phase, cwd, t]);

  const handleCatalogFill = useCallback(async () => {
    const query = model.id.trim();
    if (!query || catalogState.phase === "loading") return;
    const requestId = ++catalogRequestIdRef.current;
    setCatalogState({ phase: "loading" });
    try {
      const params = new URLSearchParams({ q: query, provider: providerName, limit: "50" });
      if (cwd) params.set("cwd", cwd);
      if (effectiveBaseUrl?.trim()) params.set("baseUrl", effectiveBaseUrl.trim());
      if (effectiveApi) params.set("api", effectiveApi);
      const res = await fetch(`/api/models-config/catalog?${params}`);
      const data = await res.json() as { recommendation?: ModelCatalogRecommendation; error?: string };
      if (requestId !== catalogRequestIdRef.current) return;
      if (!res.ok || data.error || !data.recommendation) {
        setCatalogState({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      const current = modelRef.current;
      const filled = applyCatalogPreset(current, data.recommendation.preset);
      if (filled.changedCount > 0) {
        catalogUndoRef.current = current;
        onChange(filled.model);
      }
      setCostEditing(false);
      setThinkingEditing(false);
      setCatalogState({
        phase: "success",
        recommendation: data.recommendation,
        appliedCount: filled.changedCount,
      });
    } catch (error) {
      if (requestId !== catalogRequestIdRef.current) return;
      setCatalogState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [catalogState.phase, model.id, onChange, effectiveBaseUrl, effectiveApi, providerName, cwd]);

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
      : t("models.catalogNoChanges");
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
  const thinkingLevelSummary = THINKING_LEVELS.flatMap((level) => {
    const state = thinkingLevelState(model.thinkingLevelMap, level);
    if (state === "unsupported") return [];
    return [state === "custom" ? `${THINKING_LEVEL_LABELS[level]} → ${model.thinkingLevelMap?.[level] ?? ""}` : THINKING_LEVEL_LABELS[level]];
  }).join(" · ") || t("models.thinkingNone");
  // Thinking compat is edited under Capabilities; the rest (hand-written keys included) counts here.
  const compatibilityOverrideCount = Object.keys(model.compat ?? {}).filter((key) => !THINKING_COMPAT_KEYS.includes(key)).length;
  const advancedSummaryParts = [
    model.baseUrl ? t("models.baseUrlOverride") : null,
    model.api ? `API: ${model.api}` : null,
    Object.keys(model.headers ?? {}).length
      ? t("models.headersSummary", { count: Object.keys(model.headers ?? {}).length })
      : null,
    compatibilityOverrideCount
      ? t("models.compatSummary", { count: compatibilityOverrideCount })
      : null,
    samplingInvalid
      ? t("models.samplingParamsInvalid")
      : Object.keys(model.samplingParams ?? {}).length
        ? t("models.samplingParamsSummary", { count: Object.keys(model.samplingParams ?? {}).length })
        : null,
  ].filter((part): part is string => Boolean(part));
  const advancedSummary = advancedSummaryParts.length
    ? advancedSummaryParts.join(" · ")
    : t("models.providerDefaults");

  return (
    <div className="models-form">
      <header className="settings-detail-header">
        <h2 className="settings-detail-title">{model.name || model.id || t("models.untitledModel")}</h2>
        <div className="settings-detail-meta">
          <span className="config-scope-tag">{lockId ? t("models.kindOverride") : t("models.kindDefinition")}</span>
          {shadowsBuiltIn && <span className="settings-row-status">{t("models.replacesBuiltIn")}</span>}
          {shadowsBuiltIn && onDelete && (
            <ConfigButton size="small" onClick={onDelete}>{t("models.restoreBuiltIn")}</ConfigButton>
          )}
          <span className="models-form-actions models-detail-actions">
            <ConfigButton
              size="small"
              onClick={() => void handleCatalogFill()}
              disabled={!model.id.trim() || catalogState.phase === "loading"}
            >
              {catalogState.phase === "loading" ? t("models.catalogFilling") : t("models.catalogFillAction")}
            </ConfigButton>
            <ConfigButton
              size="small"
              onClick={handleTest}
              disabled={!model.id.trim() || testState.phase === "testing"}
            >
              {testState.phase === "testing" ? t("i18n.checking") : t("models.testAction")}
            </ConfigButton>
          </span>
        </div>
      </header>

      {testSummary && (
        <Notice tone={testState.phase === "success" ? "success" : "danger"}>
          <span className="models-ellipsis" title={testSummary}>{testSummary}</span>
        </Notice>
      )}
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

      <div className="models-form-grid">
        <ConfigField label={t("models.modelId")}><TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" disabled={lockId} /></ConfigField>
        <ConfigField label={t("models.displayName")}><TextInput value={model.name ?? ""} onChange={(v) => set("name", v || undefined)} placeholder={model.id || t("models.displayName")} /></ConfigField>
      </div>

      <section className="models-section">
        <SectionHeading title={t("models.capabilities")} />
        <div className="models-switch-list">
          <SwitchRow label={t("models.imageInput")} checked={model.input?.includes("image") ?? false}
            onChange={(v) => set("input", v ? ["text", "image"] : undefined)} />
          <SwitchRow label={t("models.reasoning")} checked={model.reasoning ?? false} onChange={(v) => set("reasoning", v || undefined)} />
          {model.reasoning && effectiveApi === "anthropic-messages" && (
            <SwitchRow
              nested
              label={t("models.claudeAdaptiveThinking")}
              checked={effectiveCompat(provider, model)["forceAdaptiveThinking"] === true}
              onChange={(v) => onChange(setCompatBool(model, "forceAdaptiveThinking", v))}
            />
          )}
          {model.reasoning && effectiveApi === "openai-completions" && (
            <CompatChoiceRow
              nested
              label={t("models.deepSeekThinkingCompat")}
              value={deepseekThinkingChoice(model)}
              onChange={(v) => onChange(setDeepseekThinkingChoice(model, v))}
            />
          )}
          {model.reasoning && (
            <SettingsRow nested label={t("models.thinkingLevelMap")} description={thinkingLevelSummary}>
              <span className="models-form-actions">
                {thinkingEditing && model.thinkingLevelMap && (
                  <ConfigButton size="small" variant="ghost" onClick={() => set("thinkingLevelMap", undefined)}>
                    {t("models.thinkingReset")}
                  </ConfigButton>
                )}
                <ConfigButton size="small" variant="ghost" onClick={() => setThinkingEditing((open) => !open)} aria-expanded={thinkingEditing}>
                  {thinkingEditing ? t("models.finishEditing") : t("i18n.edit")}
                </ConfigButton>
              </span>
            </SettingsRow>
          )}
          {model.reasoning && thinkingEditing && (
            <ThinkingLevelMapEditor value={model.thinkingLevelMap} onChange={(v) => set("thinkingLevelMap", v)} explicit={lockId} />
          )}
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
            {costEditing ? t("models.finishEditing") : t("models.editCosts")}
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
            {!lockId && (
              <ConfigField label={t("models.baseUrlOverride")}>
                <TextInput value={model.baseUrl ?? ""} onChange={(v) => set("baseUrl", v.trim() || undefined)}
                  placeholder={provider.baseUrl} />
              </ConfigField>
            )}

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
            </ConfigField>

            <ConfigField label={t("models.samplingParams")}>
              <textarea
                className="models-input models-json-input"
                aria-label={t("models.samplingParams")}
                aria-invalid={samplingInvalid || undefined}
                spellCheck={false}
                value={samplingShown}
                onChange={(event) => {
                  setSamplingText(event.target.value);
                  set("samplingParams", parseSamplingParamsDraft(event.target.value));
                }}
                placeholder={'{"temperature": 0.6}'}
              />
              {samplingInvalid && (
                <span aria-live="polite" className="models-hint is-warning">{t("models.samplingParamsInvalid")}</span>
              )}
              {samplingApiSupported === false && (
                <span className="models-hint is-warning">{t("models.samplingParamsUnsupported", { api: effectiveApi ?? "" })}</span>
              )}
            </ConfigField>

            {/* pi sends the developer role only to reasoning models. */}
            {model.reasoning && effectiveApi && DEVELOPER_ROLE_APIS.has(effectiveApi) && (
              <div className="models-switch-list">
                <CompatChoiceRow
                  label={t("models.developerRole")}
                  value={compatBoolChoice(model, "supportsDeveloperRole")}
                  onChange={(v) => onChange(setCompatBoolChoice(model, "supportsDeveloperRole", v))}
                />
              </div>
            )}
          </div>
        )}
      </section>
      {onDelete && (
        <SettingsGroup>
          <SettingsRow label={t("models.deleteDefinition")}>
            <ConfigButton size="small" variant="danger" onClick={onDelete}>{t("i18n.delete")}</ConfigButton>
          </SettingsRow>
        </SettingsGroup>
      )}
    </div>
  );
}
