"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { DiscoveredModel } from "@/lib/model-discovery";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "@/lib/settings-navigation";
import {
  assignRuntimeOverride,
  diffModelOverride,
  mergeRuntimeModel,
  type ModelOverrideFields,
} from "./models-config-helpers";
import {
  appendExactRef,
  definitionsLost,
  exactRefOf,
  isExactList,
  modelPickerRef,
  removePattern,
  removeVisibleModel,
  unresolvedPatterns,
  type EnabledModelsPanelState,
  type RuntimeCatalogModel,
} from "@/lib/model-picker";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSectionTitle,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigSwitch,
} from "./SettingsUi";
import { ProviderIcon } from "./ProviderIcon";
import { ApiKeyDetail, OAuthDetail } from "./models/AuthDetail";
import { AddProviderPicker, ModelPickerDialog } from "./models/dialogs";
import { EndpointForm, ModelDiscovery } from "./models/EndpointSections";
import { Notice } from "./models/fields";
import { ModelDetail } from "./models/ModelDetail";
import {
  runtimeToEntry,
  type ApiKeyProvider,
  type ModelEntry,
  type ModelsJson,
  type OAuthProvider,
  type ProviderEntry,
} from "./models/types";

// ── Navigation ────────────────────────────────────────────────────────────────

/** A model inside a provider: its models.json definition, or a catalog model edited through an override. */
type ModelRef =
  | { kind: "definition"; index: number }
  | { kind: "runtime"; id: string };

/**
 * The panel has two views over three stores. "chat" edits which models chat
 * offers (settings `enabledModels`, saved instantly). "providers" edits
 * credentials (auth.json, instant) and endpoints/definitions (models.json,
 * a draft saved from the footer).
 */
type View =
  | { tab: "chat" }
  | { tab: "providers"; provider: string | null; model?: ModelRef };

function readRememberedView(): View {
  const raw = getLastSettingsSelection("models");
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (value && typeof value === "object") {
      const view = value as Record<string, unknown>;
      if (view.tab === "providers" && (typeof view.provider === "string" || view.provider === null)) {
        return { tab: "providers", provider: view.provider as string | null };
      }
    }
  } catch {
    // Ignore malformed browser state.
  }
  return { tab: "chat" };
}

interface ProviderRow {
  id: string;
  label: string;
  oauth?: OAuthProvider;
  apiKey?: ApiKeyProvider;
  json?: ProviderEntry;
  /** Catalog models this provider serves right now. */
  models: RuntimeCatalogModel[];
  connected: boolean;
}

// ── Main component ────────────────────────────────────────────────────────────

export function ModelsConfig({ onClose, embedded = false, cwd = null, onModelsChanged, onDirtyChange }: {
  onClose: () => void;
  embedded?: boolean;
  cwd?: string | null;
  onModelsChanged?: () => void;
  /** Reports unsaved models.json edits so the host can confirm before closing. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const [config, setConfig] = useState<ModelsJson>({ providers: {} });
  const [savedConfig, setSavedConfig] = useState<ModelsJson>({ providers: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [view, setView] = useState<View>(readRememberedView);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [discoveryFor, setDiscoveryFor] = useState<string | null>(null);
  /** Model picker: first-time setup replaces the list, adding appends to it. */
  const [modelPick, setModelPick] = useState<{ mode: "replace" | "add"; providerFilter?: string } | null>(null);
  const [catalog, setCatalog] = useState<RuntimeCatalogModel[]>([]);
  const [scopeDoc, setScopeDoc] = useState<EnabledModelsPanelState | null>(null);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const refreshAuthProviders = useCallback(() => {
    fetch(`/api/auth/providers${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`)
      .then((r) => r.json())
      .then((d: { oauthProviders?: OAuthProvider[]; apiKeyProviders?: ApiKeyProvider[] }) => {
        if (Array.isArray(d.oauthProviders)) setOauthProviders(d.oauthProviders);
        if (Array.isArray(d.apiKeyProviders)) setApiKeyProviders(d.apiKeyProviders);
      })
      .catch(() => {});
  }, [cwd]);

  const refreshRuntime = useCallback(() => {
    if (!cwd) {
      setCatalog([]);
      return;
    }
    const params = new URLSearchParams({ cwd });
    fetch(`/api/models-config/runtime?${params}`)
      .then((r) => r.json())
      .then((d: { catalog?: RuntimeCatalogModel[]; modelError?: string }) => {
        if (Array.isArray(d.catalog)) setCatalog(d.catalog);
        setRuntimeError(d.modelError ?? null);
      })
      .catch(() => {});
  }, [cwd]);

  const refreshScope = useCallback(() => {
    if (!cwd) {
      setScopeDoc(null);
      return;
    }
    fetch(`/api/models-config/picker?cwd=${encodeURIComponent(cwd)}`)
      .then(async (res) => {
        const d = await res.json() as EnabledModelsPanelState & { error?: string };
        if (!res.ok || d.error || !d.source) {
          setScopeError(d.error ?? t("models.scopeError"));
          return;
        }
        setScopeError(null);
        setScopeDoc(d);
      })
      .catch(() => setScopeError(t("models.scopeError")));
  }, [cwd, t]);

  useEffect(() => {
    if (!scopeNotice) return;
    const timer = setTimeout(() => setScopeNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [scopeNotice]);

  // Connecting or disconnecting changes which models resolve, so the chat list follows.
  const refreshAuthAndRuntime = useCallback(() => {
    refreshAuthProviders();
    refreshRuntime();
    refreshScope();
  }, [refreshAuthProviders, refreshRuntime, refreshScope]);

  useEffect(() => {
    fetch("/api/models-config")
      .then((r) => r.json())
      .then((d: ModelsJson) => {
        const normalized = d.providers ? d : { ...d, providers: {} };
        setLoadError(d.error ?? null);
        setConfig(normalized);
        setSavedConfig(normalized);
      })
      .catch(() => setConfig({ providers: {} }))
      .finally(() => setLoading(false));
    refreshAuthProviders();
  }, [refreshAuthProviders]);

  useEffect(() => {
    refreshRuntime();
    refreshScope();
  }, [refreshRuntime, refreshScope]);

  useEffect(() => {
    setLastSettingsSelection("models", JSON.stringify(view.tab === "providers"
      ? { tab: "providers", provider: view.provider }
      : { tab: "chat" }));
  }, [view]);

  const configDirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
  useEffect(() => { onDirtyChange?.(configDirty); }, [configDirty, onDirtyChange]);
  useEffect(() => {
    if (!configDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [configDirty]);

  const openProvider = useCallback((provider: string | null, model?: ModelRef) => {
    setView({ tab: "providers", provider, ...(model ? { model } : {}) });
  }, []);

  const addCustomProvider = useCallback((id: string) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [id]: { api: "openai-completions" } } }));
    openProvider(id);
  }, [openProvider]);

  const updateProvider = useCallback((name: string, p: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
  }, []);

  const deleteProvider = useCallback((name: string) => {
    setConfig((prev) => {
      const providers = { ...(prev.providers ?? {}) };
      delete providers[name];
      return { ...prev, providers };
    });
    openProvider(null);
  }, [openProvider]);

  const addModel = useCallback((providerName: string) => {
    const index = config.providers?.[providerName]?.models?.length ?? 0;
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? []), { id: "" }];
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
    openProvider(providerName, { kind: "definition", index });
  }, [config.providers, openProvider]);

  const addDiscoveredModels = useCallback((providerName: string, discovered: DiscoveredModel[]) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      const existingIds = new Set(models.map((model) => model.id));
      for (const discoveredModel of discovered) {
        if (existingIds.has(discoveredModel.id)) continue;
        existingIds.add(discoveredModel.id);
        models.push({ id: discoveredModel.id, name: discoveredModel.name });
      }
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, []);

  const updateModel = useCallback((providerName: string, index: number, m: ModelEntry) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models[index] = m;
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, []);

  const updateOverride = useCallback((providerName: string, runtime: RuntimeCatalogModel, edited: ModelEntry) => {
    const override = diffModelOverride(runtimeToEntry(runtime), { ...edited, id: runtime.id });
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const nextProvider: ProviderEntry = { ...provider };
      const modelOverrides = assignRuntimeOverride(
        provider.modelOverrides,
        runtime.id,
        override,
      );
      if (modelOverrides) nextProvider.modelOverrides = modelOverrides;
      else delete nextProvider.modelOverrides;
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: nextProvider } };
    });
  }, []);

  const removeModel = useCallback((providerName: string, index: number) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models.splice(index, 1);
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models: models.length ? models : undefined } } };
    });
    openProvider(providerName);
  }, [openProvider]);

  /** Server resolution without touching component state. */
  const fetchScopeDocument = useCallback(async (): Promise<EnabledModelsPanelState | null> => {
    if (!cwd) return null;
    const res = await fetch(`/api/models-config/picker?cwd=${encodeURIComponent(cwd)}`);
    const d = await res.json() as EnabledModelsPanelState & { error?: string };
    return !res.ok || d.error || !d.source ? null : d;
  }, [cwd]);

  /**
   * Fresh server resolution into state. `requestId` drops a response a later
   * refresh already superseded, so an out-of-order reply cannot roll the panel
   * back to an older list.
   */
  const scopeRequestIdRef = useRef(0);
  const fetchScope = useCallback(async (): Promise<EnabledModelsPanelState | null> => {
    const requestId = ++scopeRequestIdRef.current;
    const d = await fetchScopeDocument();
    if (d && requestId === scopeRequestIdRef.current) setScopeDoc(d);
    return d;
  }, [fetchScopeDocument]);

  /**
   * The one writer of `enabledModels`, serialized through a promise chain. Two
   * clicks in flight would otherwise send two whole-list replacements and the
   * slower response would undo the faster one. Each write re-derives from the
   * current server document instead of the snapshot its caller read.
   *
   * An empty list deletes the key, which means "every model", so a write that
   * would produce one is refused.
   */
  const scopeWriteRef = useRef<Promise<unknown>>(Promise.resolve());
  const saveScope = useCallback((update: (current: EnabledModelsPanelState) => string[]) => {
    if (!cwd) return Promise.resolve(false);
    const run = scopeWriteRef.current.then(async () => {
      const current = await fetchScopeDocument();
      if (!current) {
        setScopeError(t("models.scopeError"));
        return false;
      }
      if (current.readOnly) return false;
      const patterns = update(current);
      if (patterns.length === 0) {
        setScopeError(t("models.keepOneModel"));
        return false;
      }
      setScopeSaving(true);
      setScopeError(null);
      setScopeNotice(null);
      try {
        const res = await fetch("/api/models-config/picker", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, patterns }),
        });
        const d = await res.json() as EnabledModelsPanelState & { error?: string; code?: string };
        if (!res.ok || d.error || !d.source) {
          setScopeError(d.code === "untrusted" ? t("models.scopeReadOnly") : (d.error ?? t("models.scopeError")));
          return false;
        }
        setScopeDoc(d);
        onModelsChanged?.();
        return true;
      } catch {
        setScopeError(t("models.scopeError"));
        return false;
      } finally {
        setScopeSaving(false);
      }
    });
    // Keep the chain alive when this write fails, so the next one still runs.
    scopeWriteRef.current = run.catch(() => false);
    return run;
  }, [cwd, fetchScopeDocument, onModelsChanged, t]);

  const openAdd = useCallback((providerFilter?: string) => {
    // Without a loaded document there is no basis for choosing a mode, and a
    // wrong guess replaces the whole list. Refuse rather than guess.
    if (!cwd || !scopeDoc) return;
    setModelPick(scopeDoc.source === "none"
      ? { mode: "replace", ...(providerFilter ? { providerFilter } : {}) }
      : { mode: "add", ...(providerFilter ? { providerFilter } : {}) });
  }, [cwd, scopeDoc]);

  /**
   * One model leaves chat. A glob can only say "not this one" by writing out
   * the models it currently covers, so that case reports what it did.
   */
  const removeFromChat = useCallback(async (ref: string) => {
    const materializes = Boolean(scopeDoc) && !isExactList(scopeDoc?.patterns ?? []);
    const saved = await saveScope((current) => removeVisibleModel({
      patterns: current.patterns,
      visible: current.visible.map((model) => modelPickerRef(model.provider, model.id)),
      pins: current.pins,
      ref,
    }));
    if (saved && materializes) setScopeNotice(t("models.listWritten"));
  }, [saveScope, scopeDoc, t]);

  /**
   * Saving models.json can make a list entry unresolvable — a deleted
   * definition, or an id that changed. Re-resolve afterwards and drop exactly
   * the entries this save orphaned: resolvable before, not resolvable now. An
   * entry that was already orphaned stays put, so a temporary outage never
   * gets silently cleaned up by an unrelated save. A model still served by the
   * built-in catalog keeps its entry, because deleting the definition only
   * removed the override.
   */
  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const res = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setSaveError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setSavedConfig(config);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
      refreshRuntime();

      const before = scopeDoc?.defined;
      const after = await fetchScope();
      // Only a definition that this save removed justifies dropping a list
      // entry. `defined` ignores credentials, so a provider that is merely
      // signed out or briefly unreachable is not mistaken for a deleted model.
      const orphaned = before && after
        ? definitionsLost({ patterns: before.length ? scopeDoc?.patterns ?? [] : [], before: new Set(before), after: new Set(after.defined) })
        : [];
      if (orphaned.length > 0) {
        const removed = await saveScope((current) => current.patterns.filter((pattern) => !orphaned.includes(pattern)));
        if (removed) setScopeNotice(t("models.removedWithDefinition", { count: orphaned.length }));
      }
      onModelsChanged?.();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config, fetchScope, onModelsChanged, refreshRuntime, saveScope, scopeDoc, t]);

  const discardChanges = () => {
    setConfig(savedConfig);
    setSaveError(null);
    if (view.tab === "providers" && view.provider && !savedConfig.providers?.[view.provider]
      && !catalog.some((model) => model.provider === view.provider)) {
      openProvider(null);
    } else if (view.tab === "providers" && view.provider) {
      openProvider(view.provider);
    }
  };

  // A models.json that neither layer can parse disables every provider in it and
  // is the first thing to report; the footer shows one line per error.
  const configFatalError = [loadError, runtimeError]
    .filter(Boolean)
    .map((message) => String(message).split("\n")[0])
    .join(" · ") || null;

  // ── Derived data ────────────────────────────────────────────────────────────

  const chatRefs = scopeDoc?.visible ?? [];
  const listedRefs = new Set(chatRefs.map((model) => modelPickerRef(model.provider, model.id)));
  const usableRefs = new Set(catalog.map((entry) => modelPickerRef(entry.provider, entry.id)));
  // An explicit list is the only state where one model can be removed from it.
  const hasExplicitList = scopeDoc ? scopeDoc.source !== "none" && !scopeDoc.readOnly : false;
  // List entries that no longer resolve. Chat ignores them, but they still hold
  // the list back, so they must stay visible and removable.
  const unresolved = scopeDoc
    ? unresolvedPatterns({ patterns: scopeDoc.patterns, visible: [...listedRefs] })
      // An ambiguous entry is not "unavailable" — it resolves to several models
      // and needs the qualified form instead. It gets its own notice.
      .filter((pattern) => !(scopeDoc.ambiguous ?? []).includes(pattern))
    : [];
  const availableByProvider = (providerId: string) => catalog
    .filter((model) => model.provider === providerId && !listedRefs.has(modelPickerRef(model.provider, model.id)))
    .length;

  const connectedIds = new Set([
    ...oauthProviders.filter((p) => p.loggedIn).map((p) => p.id),
    ...apiKeyProviders.filter((p) => p.configured).map((p) => p.id),
  ]);
  const selectedProviderId = view.tab === "providers" ? view.provider : null;
  const providerIds: string[] = [];
  const addId = (id: string | null | undefined) => {
    if (id && !providerIds.includes(id)) providerIds.push(id);
  };
  oauthProviders.filter((p) => p.loggedIn).forEach((p) => addId(p.id));
  apiKeyProviders.filter((p) => p.configured).forEach((p) => addId(p.id));
  Object.keys(config.providers ?? {}).forEach(addId);
  catalog.forEach((model) => addId(model.provider));
  chatRefs.forEach((model) => addId(model.provider));
  addId(selectedProviderId);

  const providerRows: ProviderRow[] = providerIds.map((id) => {
    const oauth = oauthProviders.find((p) => p.id === id);
    const apiKey = apiKeyProviders.find((p) => p.id === id);
    const json = config.providers?.[id];
    const models = catalog.filter((model) => model.provider === id);
    return {
      id,
      label: json?.name ?? oauth?.name ?? apiKey?.displayName ?? id,
      ...(oauth ? { oauth } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(json ? { json } : {}),
      models,
      connected: connectedIds.has(id) || models.length > 0,
    };
  });
  const providerLabel = (id: string) => providerRows.find((row) => row.id === id)?.label ?? id;
  const providerDirty = (id: string) =>
    JSON.stringify(config.providers?.[id] ?? null) !== JSON.stringify(savedConfig.providers?.[id] ?? null);
  const catalogName = (providerId: string, id: string) =>
    catalog.find((model) => model.provider === providerId && model.id === id)?.name;

  /** Opens the editor for a model: its definition when models.json has one, else an override. */
  const modelRefFor = (providerId: string, modelId: string): ModelRef => {
    const index = (config.providers?.[providerId]?.models ?? []).findIndex((entry) => entry.id === modelId);
    return index >= 0 ? { kind: "definition", index } : { kind: "runtime", id: modelId };
  };

  // ── Shared pieces ───────────────────────────────────────────────────────────

  const chatSwitch = (ref: string, usable: boolean) => {
    if (!cwd || !scopeDoc) return null;
    const allMode = scopeDoc.source === "none";
    const inChat = listedRefs.has(ref);
    return (
      <span className="models-row-switch" title={allMode ? t("models.chatAllSwitchHint") : undefined}>
        <ConfigSwitch
          checked={inChat}
          disabled={allMode || scopeDoc.readOnly || (!usable && !inChat)}
          loading={scopeSaving}
          label={t("models.showInChat")}
          onChange={(next) => {
            if (next) void saveScope((current) => appendExactRef(current.patterns, ref));
            else void removeFromChat(ref);
          }}
        />
      </span>
    );
  };

  const scopeMessages = (
    <>
      {scopeDoc?.readOnly && <Notice tone="warning">{t("models.scopeReadOnly")}</Notice>}
      {scopeNotice && <Notice tone="info">{scopeNotice}</Notice>}
      {scopeError && <Notice tone="danger">{scopeError}</Notice>}
    </>
  );

  // ── Chat tab ────────────────────────────────────────────────────────────────

  const renderChatTab = () => {
    if (!cwd) return <ConfigEmptyState>{t("models.scopeNoCwd")}</ConfigEmptyState>;
    if (!scopeDoc) return <ConfigEmptyState>{scopeError ?? t("i18n.loading")}</ConfigEmptyState>;
    const allMode = scopeDoc.source === "none";
    const groups = new Map<string, typeof chatRefs>();
    for (const model of chatRefs) {
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }
    const whereKey = scopeDoc.source === "project" ? "models.scopeWhereProject" : "models.scopeWhereGlobal";

    return (
      <div className="models-page">
        <div className="models-scope-card">
          <div className="models-scope-copy">
            <strong>{allMode ? t("models.chatAllTitle", { count: chatRefs.length }) : t("models.chatListTitle", { count: chatRefs.length })}</strong>
            <span>{t("models.chatScopeDesc", { where: t(whereKey) })}</span>
          </div>
          {!scopeDoc.readOnly && (
            <ConfigButton variant={allMode ? "secondary" : "primary"} onClick={() => openAdd()}>
              {allMode ? t("models.pickOnlyThese") : t("models.addToChat")}
            </ConfigButton>
          )}
        </div>
        {scopeMessages}

        {unresolved.length > 0 && (
          <RemovableEntries
            title={t("models.unavailable", { count: unresolved.length })}
            hint={t("models.unavailableHint")}
            entries={unresolved}
            readOnly={Boolean(scopeDoc.readOnly)}
            onRemove={(pattern) => void saveScope((current) => removePattern(current.patterns, pattern))}
          />
        )}
        {(scopeDoc.ambiguous?.length ?? 0) > 0 && (
          <RemovableEntries
            title={t("models.ambiguous", { count: scopeDoc.ambiguous?.length ?? 0 })}
            hint={t("models.ambiguousHint")}
            entries={scopeDoc.ambiguous ?? []}
            readOnly={Boolean(scopeDoc.readOnly)}
            onRemove={(pattern) => void saveScope((current) => removePattern(current.patterns, pattern))}
          />
        )}

        {groups.size === 0 && <p className="models-empty">{t("models.chatEmpty")}</p>}
        {[...groups.entries()].map(([providerId, models]) => {
          const availableCount = availableByProvider(providerId);
          return (
            <section key={providerId} className="models-group">
              <div className="models-group-header">
                <ProviderIcon id={providerId} size={16} />
                <span className="models-group-title">{providerLabel(providerId)}</span>
                <span className="models-hint">{models.length}</span>
                <ConfigButton size="small" variant="ghost" className="models-push-right" onClick={() => openProvider(providerId)}>
                  {t("models.manageProvider")}
                </ConfigButton>
              </div>
              <div className="models-list">
                {models.map((model) => {
                  const ref = modelPickerRef(model.provider, model.id);
                  const pin = scopeDoc.pins[ref];
                  const name = catalogName(model.provider, model.id);
                  return (
                    <div key={ref} className="models-row">
                      <button
                        type="button"
                        className="models-row-main models-row-button"
                        title={t("models.editParams")}
                        onClick={() => openProvider(providerId, modelRefFor(providerId, model.id))}
                      >
                        <span className="models-row-title">{name || model.id}</span>
                        {name && name !== model.id && <code className="models-row-sub">{model.id}</code>}
                      </button>
                      {pin && <span className="models-tag">{t("models.thinkingPin", { level: pin })}</span>}
                      {hasExplicitList && (
                        <ConfigButton size="small" variant="ghost" className="models-remove" onClick={() => void removeFromChat(ref)}>
                          {t("models.removeFromChat")}
                        </ConfigButton>
                      )}
                    </div>
                  );
                })}
                {availableCount > 0 && (
                  <button type="button" className="models-row-more" onClick={() => openAdd(providerId)}>
                    {t("models.availableMore", { count: availableCount })}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    );
  };

  // ── Providers tab ───────────────────────────────────────────────────────────

  const renderProviderPage = (row: ProviderRow) => {
    const json = row.json;
    // OAuth/API-key providers ship with the SDK; their models.json entry only overrides.
    const builtIn = Boolean(row.oauth || row.apiKey);
    const showApiKey = row.apiKey && (!row.oauth || row.apiKey.configured || !row.oauth.loggedIn);
    const definitions = json?.models ?? [];
    // Catalog models plus definitions that do not resolve yet, so every
    // definition stays reachable whether or not the provider is connected.
    const modelRows: { id: string; name?: string; ref: ModelRef; usable: boolean; definition: boolean }[] = [
      ...row.models.map((model) => {
        const index = definitions.findIndex((entry) => entry.id === model.id);
        return {
          id: model.id,
          name: model.name,
          ref: index >= 0 ? { kind: "definition", index } as const : { kind: "runtime", id: model.id } as const,
          usable: true,
          definition: index >= 0,
        };
      }),
      ...definitions
        .map((model, index) => ({ model, index }))
        .filter(({ model }) => !usableRefs.has(`${row.id}/${model.id}`))
        .map(({ model, index }) => ({
          id: model.id,
          name: model.name,
          ref: { kind: "definition", index } as const,
          usable: false,
          definition: true,
        })),
    ];
    const allMode = scopeDoc?.source === "none";

    return (
      <div className="models-form">
        <ConfigDetailHeader>
          <ConfigDetailHeaderInfo>
            <ProviderIcon id={row.id} size={28} />
            <div className="models-title-block">
              <strong className="models-title">{row.label}</strong>
              <span className="models-subtitle">
                <code>{row.id}</code>
                {row.oauth && <span className="models-tag">{t("models.kindOAuth")}</span>}
                {row.apiKey && <span className="models-tag">{t("models.kindApiKey")}</span>}
                {json && <span className="models-tag is-accent">{builtIn ? t("models.kindOverridden") : t("models.kindCustom")}</span>}
              </span>
            </div>
          </ConfigDetailHeaderInfo>
          {json && (
            <ConfigDetailActions>
              <ConfigButton size="small" variant="danger" onClick={() => { deleteProvider(row.id); if (builtIn) openProvider(row.id); }}>
                {builtIn ? t("models.deleteOverride") : t("models.deleteEndpoint")}
              </ConfigButton>
            </ConfigDetailActions>
          )}
        </ConfigDetailHeader>

        {(row.oauth || showApiKey) && (
          <section className="models-section">
            <div className="models-section-heading">
              <ConfigSectionTitle>{t("models.sectionConnection")}</ConfigSectionTitle>
              <span className="models-hint">{t("models.sectionConnectionHint")}</span>
            </div>
            {row.oauth && <OAuthDetail key={row.oauth.id} provider={row.oauth} onRefresh={refreshAuthAndRuntime} cwd={cwd} />}
            {showApiKey && row.apiKey && <ApiKeyDetail key={`${row.apiKey.id}-key`} provider={row.apiKey} onRefresh={refreshAuthAndRuntime} cwd={cwd} />}
          </section>
        )}

        {json && (
          <section className="models-section">
            <div className="models-section-heading">
              <ConfigSectionTitle>{builtIn ? t("models.sectionEndpointOverride") : t("models.sectionEndpoint")}</ConfigSectionTitle>
              <span className="models-hint">{builtIn ? t("models.sectionOverrideHint") : t("models.sectionDraftHint")}</span>
            </div>
            <EndpointForm
              key={row.id}
              providerId={row.id}
              provider={json}
              builtIn={builtIn}
              namePlaceholder={row.oauth?.name ?? row.apiKey?.displayName ?? row.id}
              onChange={(next) => updateProvider(row.id, next)}
            />
          </section>
        )}

        <section className="models-section">
          <div className="models-section-header">
            <div className="models-section-heading">
              <ConfigSectionTitle>{t("models.sectionModels", { count: modelRows.length })}</ConfigSectionTitle>
              {cwd && scopeDoc && (
                <span className="models-hint">{allMode ? t("models.chatAllSwitchHint") : t("models.chatSwitchHint")}</span>
              )}
            </div>
            {json && (
              <span className="models-form-actions">
                <ConfigButton size="small" disabled={!json.baseUrl?.trim()} title={json.baseUrl?.trim() ? undefined : t("models.discoveryNeedsBaseUrl")} onClick={() => setDiscoveryFor(row.id)}>
                  {t("models.discoveryFetch")}
                </ConfigButton>
                <ConfigButton size="small" onClick={() => addModel(row.id)}>{t("models.newModel")}</ConfigButton>
              </span>
            )}
          </div>
          {scopeMessages}
          {json && discoveryFor === row.id && (
            <ModelDiscovery
              providerId={row.id}
              provider={json}
              onAddModels={(models) => addDiscoveredModels(row.id, models)}
              onClose={() => setDiscoveryFor(null)}
            />
          )}
          {modelRows.length === 0 ? (
            <p className="models-empty">{json ? t("models.noDefinitions") : t("models.connectToSeeModels")}</p>
          ) : (
            <div className="models-list">
              {modelRows.map((model) => {
                const ref = modelPickerRef(row.id, model.id);
                return (
                  <div key={`${model.ref.kind}:${model.id}:${model.ref.kind === "definition" ? model.ref.index : ""}`} className="models-row">
                    <button type="button" className="models-row-main models-row-button" onClick={() => openProvider(row.id, model.ref)}>
                      <span className="models-row-title">{model.name && model.name !== model.id ? model.name : (model.id || t("models.untitledModel"))}</span>
                      {model.name && model.name !== model.id && <code className="models-row-sub">{model.id}</code>}
                    </button>
                    {model.definition && <span className="models-tag is-accent">{t("models.kindDefinition")}</span>}
                    {!model.usable && <span className="models-tag is-warning">{t("models.notUsable")}</span>}
                    {scopeDoc?.pins[ref] && <span className="models-tag">{t("models.thinkingPin", { level: scopeDoc.pins[ref] })}</span>}
                    {model.id && chatSwitch(ref, model.usable)}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    );
  };

  const renderModelPage = (row: ProviderRow, ref: ModelRef) => {
    const back = (
      <button type="button" className="models-breadcrumb" onClick={() => openProvider(row.id)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        <ProviderIcon id={row.id} size={14} />
        {row.label}
      </button>
    );
    if (ref.kind === "runtime") {
      const runtime = catalog.find((model) => model.provider === row.id && model.id === ref.id);
      if (!runtime) return null;
      const provider = config.providers?.[row.id] ?? {};
      const override = provider.modelOverrides?.[runtime.id] as ModelOverrideFields | undefined;
      const model = mergeRuntimeModel(runtimeToEntry(runtime), override);
      return (
        <>
          {back}
          <ModelDetail
            key={`${row.id}-${ref.id}`}
            providerName={row.id}
            provider={provider}
            model={model}
            lockId
            cwd={cwd}
            onChange={(next) => updateOverride(row.id, runtime, next)}
          />
        </>
      );
    }
    const provider = config.providers?.[row.id];
    const model = provider?.models?.[ref.index];
    if (!provider || !model) return null;
    return (
      <>
        {back}
        <ModelDetail
          key={`${row.id}-${ref.index}`}
          providerName={row.id}
          provider={provider}
          model={model}
          cwd={cwd}
          onChange={(m) => updateModel(row.id, ref.index, m)}
          onDelete={() => removeModel(row.id, ref.index)}
        />
      </>
    );
  };

  const renderProvidersTab = () => {
    const activeId = selectedProviderId ?? providerRows[0]?.id ?? null;
    const active = providerRows.find((row) => row.id === activeId);
    const model = view.tab === "providers" && view.provider === activeId ? view.model : undefined;
    const connectedRows = providerRows.filter((row) => row.connected);
    const otherRows = providerRows.filter((row) => !row.connected);
    const item = (row: ProviderRow) => (
      <ConfigSidebarItem key={row.id} active={row.id === activeId} onClick={() => openProvider(row.id)}>
        <ProviderIcon id={row.id} size={16} />
        <ConfigSidebarText className={`is-grow${row.connected ? "" : " is-muted"}`}>{row.label}</ConfigSidebarText>
        {providerDirty(row.id) && <span className="models-dirty-dot" title={t("models.unsavedProvider")} />}
      </ConfigSidebarItem>
    );
    return (
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            {loading && <div className="config-sidebar-message">{t("i18n.loading")}</div>}
            {connectedRows.length > 0 && <ConfigSidebarGroupLabel>{t("models.groupConnected")}</ConfigSidebarGroupLabel>}
            {connectedRows.map(item)}
            {otherRows.length > 0 && <ConfigSidebarGroupLabel>{t("models.groupNotConnected")}</ConfigSidebarGroupLabel>}
            {otherRows.map(item)}
          </ConfigSidebarList>
          <ConfigListAction onClick={() => setPickerOpen(true)}>{t("models.addProvider")}</ConfigListAction>
        </ConfigSidebar>
        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {loading ? null : !active ? (
              <ConfigEmptyState>{t("models.noProviders")}</ConfigEmptyState>
            ) : model ? (
              renderModelPage(active, model) ?? renderProviderPage(active)
            ) : (
              renderProviderPage(active)
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>
    );
  };

  const anyDirty = configDirty;
  const tab = (id: View["tab"], label: string, extra?: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={view.tab === id}
      className="models-tab"
      onClick={() => setView(id === "chat" ? { tab: "chat" } : { tab: "providers", provider: selectedProviderId })}
    >
      {label}
      {extra}
    </button>
  );

  return (
    <>
    <ConfigPanelShell embedded={embedded} title={t("common.models")} closeLabel={t("i18n.close")} onClose={onClose}>
      <div className="models-tabs" role="tablist" aria-label={t("common.models")}>
        {tab("chat", t("models.tabChat"), cwd && scopeDoc ? <span className="models-tab-count">{chatRefs.length}</span> : null)}
        {tab("providers", t("models.tabProviders"), anyDirty ? <span className="models-dirty-dot" title={t("models.unsavedChanges")} /> : null)}
      </div>

      {view.tab === "chat" ? <div className="models-scroll">{renderChatTab()}</div> : renderProvidersTab()}

      {(configDirty || saving || savedOk || saveError || configFatalError) && (
        <ConfigFooter status={(saveError || configFatalError) ? (
          <span className="models-footer-status is-danger" title={configFatalError ?? undefined}>{saveError || configFatalError}</span>
        ) : configDirty ? (
          <span className="models-footer-status"><span className="models-dirty-dot" />{t("models.unsavedChanges")}</span>
        ) : null}>
          {!embedded && <ConfigButton onClick={onClose}>{t("i18n.cancel")}</ConfigButton>}
          {configDirty && !saving && (
            <ConfigButton onClick={discardChanges}>{t("models.discardChanges")}</ConfigButton>
          )}
          {(configDirty || saving || savedOk) && (
            <ConfigButton
              variant="primary"
              onClick={handleSave}
              disabled={saving || savedOk}
              className={savedOk ? "is-success" : undefined}
            >
              {savedOk && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                  className="config-button-success-icon">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
              <span>{savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("models.saveModelsJson")}</span>
            </ConfigButton>
          )}
        </ConfigFooter>
      )}
    </ConfigPanelShell>
    {pickerOpen && (
      <AddProviderPicker
        oauthProviders={oauthProviders}
        apiKeyProviders={apiKeyProviders}
        existingIds={new Set([...Object.keys(config.providers ?? {}), ...oauthProviders.map((p) => p.id), ...apiKeyProviders.map((p) => p.id), ...catalog.map((model) => model.provider)])}
        onSelectOAuth={(id) => openProvider(id)}
        onSelectApiKey={(id) => openProvider(id)}
        onAddCustom={addCustomProvider}
        onClose={() => setPickerOpen(false)}
      />
    )}
    {modelPick && (
      <ModelPickerDialog
        catalog={catalog}
        listedRefs={modelPick.mode === "replace" ? new Set() : listedRefs}
        mode={modelPick.mode}
        {...(modelPick.providerFilter ? { providerFilter: modelPick.providerFilter } : {})}
        providerLabel={providerLabel}
        saving={scopeSaving}
        error={scopeError}
        onClose={() => setModelPick(null)}
        onApply={(refs) => {
          const { mode } = modelPick;
          setModelPick(null);
          void saveScope((current) => mode === "replace"
            ? refs
            : refs.reduce((list, ref) => appendExactRef(list, ref), current.patterns));
        }}
      />
    )}
    </>
  );
}

/**
 * A group of list entries the panel cannot render as models, with a removal
 * action. Used for entries that resolve to nothing and for ambiguous ones.
 */
function RemovableEntries({
  title,
  hint,
  entries,
  readOnly,
  onRemove,
}: {
  title: string;
  hint: string;
  entries: readonly string[];
  readOnly: boolean;
  onRemove: (pattern: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Notice tone="warning">
      <strong>{title}</strong>
      <span className="models-notice-hint">{hint}</span>
      <div className="models-notice-list">
        {entries.map((pattern) => (
          <div key={pattern} className="models-notice-entry">
            <code>{exactRefOf(pattern)?.id ?? pattern}</code>
            {!readOnly && (
              <ConfigButton size="small" variant="ghost" onClick={() => onRemove(pattern)}>
                {t("models.removeFromChat")}
              </ConfigButton>
            )}
          </div>
        ))}
      </div>
    </Notice>
  );
}
