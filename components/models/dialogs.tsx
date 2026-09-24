"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { modelPickerRef, type RuntimeCatalogModel } from "@/lib/model-picker";
import { ConfigButton } from "../SettingsUi";
import { ProviderIcon } from "../ProviderIcon";
import { Hint, ModelsDialog, Notice } from "./fields";
import type { ApiKeyProvider, OAuthProvider } from "./types";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function useAutofocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => { setTimeout(() => ref.current?.focus(), 30); }, []);
  return ref;
}

export function AddProviderPicker({
  oauthProviders, apiKeyProviders, existingIds,
  onSelectOAuth, onSelectApiKey, onAddCustom, onClose,
}: {
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
  existingIds: ReadonlySet<string>;
  onSelectOAuth: (id: string) => void;
  onSelectApiKey: (id: string) => void;
  onAddCustom: (id: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customId, setCustomId] = useState("");
  const { t } = useI18n();
  const inputRef = useAutofocus<HTMLInputElement>();

  const q = search.trim().toLowerCase();
  const availableOAuth = oauthProviders.filter((p) => !p.loggedIn && (!q || p.name.toLowerCase().includes(q)));
  const availableApiKey = apiKeyProviders.filter((p) => !p.configured && (!q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
  const showCustom = !q || "custom".includes(q) || "openai-compatible".includes(q) || "anthropic-compatible".includes(q);
  const totalCount = availableOAuth.length + availableApiKey.length + (showCustom ? 1 : 0);
  const trimmedId = customId.trim();
  const customIdValid = PROVIDER_ID_PATTERN.test(trimmedId) && !existingIds.has(trimmedId);

  const card = (key: string, title: string, subtitle: string, icon: React.ReactNode, onClick: () => void) => (
    <button key={key} type="button" className="models-card" onClick={onClick}>
      <span className="models-card-copy">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </span>
      {icon}
    </button>
  );

  return (
    <ModelsDialog
      title={t("models.addProviderTitle")}
      width={820}
      onClose={onClose}
      header={(
        <div className="models-dialog-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("i18n.searchProviders")}
            aria-label={t("i18n.searchProviders")}
          />
        </div>
      )}
    >
      {totalCount === 0 ? (
        <p className="models-empty">{t("i18n.noProviders")}</p>
      ) : (
        <div className="models-card-grid">
          {showCustom && <div className="models-card-group">{t("i18n.custom")}</div>}
          {showCustom && !customOpen && card(
            "custom",
            t("models.customCompatible"),
            t("i18n.customEndpoint"),
            <span className="models-card-plus" aria-hidden="true">+</span>,
            () => setCustomOpen(true),
          )}
          {showCustom && customOpen && (
            <form
              className="models-custom-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!customIdValid) return;
                onAddCustom(trimmedId);
                onClose();
              }}
            >
              <label htmlFor="custom-provider-id" className="config-field-label">{t("models.providerId")}</label>
              <input
                id="custom-provider-id"
                autoFocus
                className="models-input is-mono"
                value={customId}
                onChange={(event) => setCustomId(event.target.value)}
                placeholder="my-provider"
                aria-describedby="custom-provider-id-hint"
              />
              <span id="custom-provider-id-hint">
                <Hint>{existingIds.has(trimmedId) ? t("models.providerIdTaken") : t("models.providerIdFormat")}</Hint>
              </span>
              <div className="models-form-actions">
                <ConfigButton size="small" onClick={() => setCustomOpen(false)}>{t("i18n.cancel")}</ConfigButton>
                <ConfigButton size="small" type="submit" variant="primary" disabled={!customIdValid}>
                  {t("models.createProvider")}
                </ConfigButton>
              </div>
            </form>
          )}

          {availableOAuth.length > 0 && <div className="models-card-group">{t("i18n.subscriptions")}</div>}
          {availableOAuth.map((p) => card(p.id, p.name, t("models.kindOAuth"), <ProviderIcon id={p.id} size={28} />, () => { onSelectOAuth(p.id); onClose(); }))}

          {availableApiKey.length > 0 && <div className="models-card-group">{t("models.kindApiKey")}</div>}
          {availableApiKey.map((p) => card(p.id, p.displayName, t("models.modelCount", { count: p.modelCount }), <ProviderIcon id={p.id} size={28} />, () => { onSelectApiKey(p.id); onClose(); }))}
        </div>
      )}
    </ModelsDialog>
  );
}

/**
 * Picking models for chat. One dialog serves both entries: first-time setup
 * (nothing selected yet) and adding to an existing list. Both are the same
 * action — "these models should be in chat" — so they share one UI.
 */
export function ModelPickerDialog({
  catalog,
  listedRefs,
  mode,
  providerFilter,
  providerLabel,
  saving,
  error,
  onClose,
  onApply,
}: {
  catalog: RuntimeCatalogModel[];
  /** Models already in chat. Empty when picking a list from scratch. */
  listedRefs: ReadonlySet<string>;
  mode: "replace" | "add";
  providerFilter?: string;
  providerLabel: (providerId: string) => string;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onApply: (refs: string[]) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const inputRef = useAutofocus<HTMLInputElement>();

  const normalizedQuery = query.trim().toLocaleLowerCase();
  // Models already in chat stay listed, checked and locked, so the provider's
  // full set is visible and a missing model is not mistaken for an outage.
  const shown = catalog.filter((model) => (
    (!providerFilter || model.provider === providerFilter)
    && (!normalizedQuery
      || model.id.toLocaleLowerCase().includes(normalizedQuery)
      || model.name?.toLocaleLowerCase().includes(normalizedQuery))
  ));
  const isListed = (model: RuntimeCatalogModel) => listedRefs.has(modelPickerRef(model.provider, model.id));
  const grouped = new Map<string, RuntimeCatalogModel[]>();
  for (const model of shown) {
    const list = grouped.get(model.provider) ?? [];
    list.push(model);
    grouped.set(model.provider, list);
  }

  const toggle = (ref: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(ref)) next.delete(ref);
    else next.add(ref);
    return next;
  });

  return (
    <ModelsDialog
      title={t("models.pickModels")}
      description={mode === "replace" ? t("models.pickReplaceHint") : t("models.pickAddHint")}
      onClose={onClose}
      footer={(
        <>
          <span className="models-hint">{t("models.pickSelected", { count: selected.size })}</span>
          <span className="models-form-actions">
            <ConfigButton onClick={onClose}>{t("i18n.cancel")}</ConfigButton>
            <ConfigButton variant="primary" disabled={selected.size === 0 || saving} onClick={() => onApply([...selected])}>
              {t("models.pickApply", { count: selected.size })}
            </ConfigButton>
          </span>
        </>
      )}
    >
      <input
        ref={inputRef}
        className="models-input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("models.pickFilterPlaceholder")}
        aria-label={t("models.pickFilter")}
      />
      {!shown.some((model) => !isListed(model)) && <p className="models-empty">{t("models.noExtraModels")}</p>}
      {[...grouped.entries()].map(([providerId, models]) => {
        const refs = models.filter((model) => !isListed(model)).map((model) => modelPickerRef(model.provider, model.id));
        const allSelected = refs.length > 0 && refs.every((ref) => selected.has(ref));
        return (
          <section key={providerId} className="models-picker-group">
            <label className="models-picker-head">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={refs.length === 0}
                onChange={() => setSelected((current) => {
                  const next = new Set(current);
                  for (const ref of refs) {
                    if (allSelected) next.delete(ref);
                    else next.add(ref);
                  }
                  return next;
                })}
              />
              <ProviderIcon id={providerId} size={14} />
              <span>{providerLabel(providerId)}</span>
              <span className="models-count">{models.length}</span>
            </label>
            {models.map((model) => {
              const ref = modelPickerRef(model.provider, model.id);
              const listed = isListed(model);
              return (
                <label key={ref} className={`models-row${listed ? " is-disabled" : ""}`}>
                  <input type="checkbox" checked={listed || selected.has(ref)} disabled={listed} onChange={() => toggle(ref)} />
                  <span className="models-row-text">
                    <span className="models-row-title">{model.name || model.id}</span>
                    {model.name && model.name !== model.id && <code className="models-row-sub">{model.id}</code>}
                  </span>
                  {listed && <span className="models-tag">{t("models.alreadyInChat")}</span>}
                </label>
              );
            })}
          </section>
        );
      })}
      {error && <Notice tone="danger">{error}</Notice>}
    </ModelsDialog>
  );
}
