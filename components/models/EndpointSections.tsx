"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { DiscoveredModel } from "@/lib/model-discovery";
import { ConfigButton, ConfigField } from "../SettingsUi";
import { HeaderListEditor, Hint, Notice, SecretTextInput, Select, TextInput } from "./fields";
import { API_OPTIONS, type ProviderEntry } from "./types";

type ModelDiscoveryState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; models: DiscoveredModel[]; endpoint: string }
  | { phase: "error"; message: string };

/**
 * The provider-level part of a models.json entry: where and how to call it.
 * For a built-in provider the entry is an override, so every field is optional
 * and blank means the built-in default.
 */
export function EndpointForm({ providerId, provider, builtIn, namePlaceholder, onChange }: {
  /** The provider id, which keys models.json, auth.json, and enabledModels. */
  providerId: string;
  provider: ProviderEntry;
  builtIn: boolean;
  namePlaceholder: string;
  onChange: (p: ProviderEntry) => void;
}) {
  const { t } = useI18n();
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  // A custom provider needs a protocol; an override must not gain one silently.
  useEffect(() => {
    if (!builtIn && !provider.api) onChange({ ...provider, api: "openai-completions" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.api, builtIn]);

  return (
    <div className="models-form">
      <div className="models-form-grid">
        <ConfigField label={t("models.displayName")}>
          <TextInput
            value={provider.name ?? ""}
            onChange={(v) => set("name", v.trim() || undefined)}
            placeholder={namePlaceholder}
          />
          <Hint>{t("models.providerIdHint", { id: providerId })}</Hint>
        </ConfigField>
        <ConfigField label={t("models.apiProtocol")}>
          {builtIn ? (
            <Select value={provider.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
          ) : (
            <Select value={provider.api ?? "openai-completions"} onChange={(v) => set("api", v)} options={API_OPTIONS} required />
          )}
        </ConfigField>
      </div>

      <ConfigField label={t("models.baseUrl")}>
        <TextInput value={provider.baseUrl ?? ""} onChange={(v) => set("baseUrl", v || undefined)}
          placeholder={builtIn ? t("models.builtInDefault") : "https://api.example.com/v1"} mono />
      </ConfigField>

      <ConfigField label={t("models.apiKeyTitle")}>
        <SecretTextInput value={provider.apiKey ?? ""} onChange={(v) => set("apiKey", v || undefined)}
          placeholder={builtIn ? t("models.builtInKeyPlaceholder") : t("models.endpointKeyPlaceholder")} mono />
        <Hint>{t("models.endpointKeyHint")}</Hint>
      </ConfigField>

      <ConfigField label={t("models.headers")}>
        <HeaderListEditor
          headers={provider.headers}
          onChange={(headers) => set("headers", headers)}
        />
        <Hint>{t("models.providerHeadersHelp")}</Hint>
      </ConfigField>
    </div>
  );
}

/** Fetches the endpoint's model list and appends the picked ids as definitions. */
export function ModelDiscovery({ providerId, provider, onAddModels, onClose }: {
  providerId: string;
  provider: ProviderEntry;
  onAddModels: (models: DiscoveredModel[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [discoveryState, setDiscoveryState] = useState<ModelDiscoveryState>({ phase: "idle" });
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const discoveryRequestIdRef = useRef(0);
  const selectShownRef = useRef<HTMLInputElement>(null);

  const handleDiscoverModels = useCallback(async () => {
    if (!provider.baseUrl?.trim()) return;
    const requestId = ++discoveryRequestIdRef.current;
    setDiscoveryState({ phase: "loading" });
    setSelectedModelIds([]);
    try {
      const res = await fetch("/api/models-config/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName: providerId, provider: { ...provider, models: undefined } }),
      });
      const data = await res.json() as { models?: DiscoveredModel[]; endpoint?: string; error?: string };
      if (requestId !== discoveryRequestIdRef.current) return;
      if (!res.ok || data.error || !data.models) {
        setDiscoveryState({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setDiscoveryState({ phase: "success", models: data.models, endpoint: data.endpoint ?? provider.baseUrl });
    } catch (error) {
      if (requestId !== discoveryRequestIdRef.current) return;
      setDiscoveryState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [providerId, provider]);

  // Fetch on open, and again whenever the endpoint it would call changes.
  useEffect(() => {
    void handleDiscoverModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, provider.baseUrl, provider.api, provider.apiKey]);

  const existingModelIds = new Set((provider.models ?? []).map((model) => model.id));
  const discoveredModels = discoveryState.phase === "success" ? discoveryState.models : [];
  const normalizedDiscoveryQuery = discoveryQuery.trim().toLocaleLowerCase();
  const filteredDiscoveredModels = discoveredModels.filter((model) => !normalizedDiscoveryQuery
    || model.id.toLocaleLowerCase().includes(normalizedDiscoveryQuery)
    || model.name?.toLocaleLowerCase().includes(normalizedDiscoveryQuery));
  const shownDiscoveredModels = filteredDiscoveredModels.slice(0, 300);
  const selectableShownIds = shownDiscoveredModels
    .filter((model) => !existingModelIds.has(model.id))
    .map((model) => model.id);
  const selectedCount = selectedModelIds.filter((id) => !existingModelIds.has(id)).length;
  const allShownSelected = selectableShownIds.length > 0
    && selectableShownIds.every((id) => selectedModelIds.includes(id));
  const someShownSelected = !allShownSelected
    && selectableShownIds.some((id) => selectedModelIds.includes(id));

  useEffect(() => {
    if (selectShownRef.current) selectShownRef.current.indeterminate = someShownSelected;
  }, [someShownSelected]);

  const toggleDiscoveredModel = (id: string) => {
    setSelectedModelIds((current) => current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id]);
  };

  const toggleShownModels = () => {
    const shownIds = new Set(selectableShownIds);
    setSelectedModelIds((current) => allShownSelected
      ? current.filter((id) => !shownIds.has(id))
      : Array.from(new Set([...current, ...selectableShownIds])));
  };

  const addSelectedModels = () => {
    if (discoveryState.phase !== "success") return;
    const selected = new Set(selectedModelIds);
    const additions = discoveryState.models.filter((model) => selected.has(model.id) && !existingModelIds.has(model.id));
    if (additions.length === 0) return;
    onAddModels(additions);
    setSelectedModelIds([]);
  };

  return (
    <div className="models-discovery">
      <div className="models-discovery-header">
        <strong>{t("models.discoveryTitle")}</strong>
        <ConfigButton size="small" variant="ghost" onClick={onClose}>{t("i18n.close")}</ConfigButton>
      </div>

      {discoveryState.phase === "loading" && <p className="models-muted">{t("models.discoveryFetching")}</p>}
      {discoveryState.phase === "error" && (
        <Notice tone="danger" action={<ConfigButton size="small" onClick={() => void handleDiscoverModels()}>{t("models.retry")}</ConfigButton>}>
          {discoveryState.message}
        </Notice>
      )}

      {discoveryState.phase === "success" && (
        <>
          <input
            className="models-input"
            value={discoveryQuery}
            onChange={(event) => setDiscoveryQuery(event.target.value)}
            placeholder={t("models.discoveryFilterPlaceholder", { count: discoveryState.models.length })}
            aria-label={t("models.discoveryFilter")}
          />

          <div className="models-list models-discovery-list">
            <label className="models-row models-discovery-all">
              <input
                ref={selectShownRef}
                type="checkbox"
                checked={allShownSelected}
                disabled={selectableShownIds.length === 0}
                onChange={toggleShownModels}
              />
              {t("models.discoverySelectShown")}
            </label>
            {shownDiscoveredModels.length === 0 ? (
              <div className="models-row models-muted">{t("models.discoveryNoMatches")}</div>
            ) : shownDiscoveredModels.map((model) => {
              const alreadyAdded = existingModelIds.has(model.id);
              return (
                <label key={model.id} className={`models-row${alreadyAdded ? " is-disabled" : ""}`}>
                  <input
                    type="checkbox"
                    checked={selectedModelIds.includes(model.id) || alreadyAdded}
                    disabled={alreadyAdded}
                    onChange={() => toggleDiscoveredModel(model.id)}
                  />
                  <span className="models-row-text">
                    <span className="models-row-title">{model.name ?? model.id}</span>
                    {model.name && <code className="models-row-sub">{model.id}</code>}
                  </span>
                  {alreadyAdded && <span className="models-tag">{t("models.discoveryAdded")}</span>}
                </label>
              );
            })}
          </div>

          <div className="models-discovery-footer">
            <span className="models-hint" title={discoveryState.endpoint}>
              {filteredDiscoveredModels.length > shownDiscoveredModels.length
                ? t("models.discoveryShowing", { shown: shownDiscoveredModels.length, total: filteredDiscoveredModels.length })
                : t("models.discoveryFetched", { count: discoveryState.models.length })}
            </span>
            <ConfigButton size="small" variant="primary" onClick={addSelectedModels} disabled={selectedCount === 0}>
              {selectedCount
                ? t("models.discoveryAddSelectedCount", { count: selectedCount })
                : t("models.discoveryAddSelected")}
            </ConfigButton>
          </div>
        </>
      )}
    </div>
  );
}
