"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getJson, peekJson, settingsUrls, type JsonReply } from "@/lib/settings-cache";
import type { DiscoveredModel } from "@/lib/model-discovery";
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
  ConfigEmptyState,
  ConfigFooter,
  ConfigPanelShell,
  ConfigSwitch,
  CountedTitle,
  SettingsBackLink,
  SettingsGroup,
  SettingsLinkRow,
  SettingsLoading,
  SettingsRow,
} from "./SettingsUi";
import { ProviderIcon } from "./ProviderIcon";
import { ApiKeyDetail, OAuthDetail } from "./models/AuthDetail";
import { AddProviderPicker, ModelPickerDialog } from "./models/dialogs";
import { EndpointForm, ModelDiscovery } from "./models/EndpointSections";
import { Notice, SectionHeading } from "./models/fields";
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
 * One view over three stores: which models chat offers (settings
 * `enabledModels`, saved instantly), credentials (auth.json, instant), and
 * endpoints/definitions (models.json, a draft saved from the footer).
 */
interface View {
  provider: string | null;
  model?: ModelRef;
}

type AuthProvidersReply = { oauthProviders?: OAuthProvider[]; apiKeyProviders?: ApiKeyProvider[] };
type RuntimeReply = { catalog?: RuntimeCatalogModel[]; builtIn?: string[]; modelError?: string };
type ScopeReply = EnabledModelsPanelState & { error?: string };

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
  /** No provider means the provider list; the page always opens there. */
  const [view, setView] = useState<View>({ provider: null });
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [discoveryFor, setDiscoveryFor] = useState<string | null>(null);
  /** Model picker: first-time setup replaces the list, adding appends to it. */
  const [modelPick, setModelPick] = useState<"replace" | "add" | null>(null);
  const [catalog, setCatalog] = useState<RuntimeCatalogModel[]>([]);
  /** `provider/id` of shipped models on providers models.json touches. */
  const [builtInRefs, setBuiltInRefs] = useState<ReadonlySet<string>>(new Set());
  const [scopeDoc, setScopeDoc] = useState<EnabledModelsPanelState | null>(null);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});

  // Each source has an apply step so the mount can paint the cached reply first.
  const configDirtyRef = useRef(false);
  const applyConfig = useCallback((d: ModelsJson) => {
    setLoadError(d.error ?? null);
    // Revalidation never discards a draft the user already started.
    if (configDirtyRef.current) return;
    const normalized = d.providers ? d : { ...d, providers: {} };
    setConfig(normalized);
    setSavedConfig(normalized);
  }, []);

  const applyAuthProviders = useCallback((d: AuthProvidersReply) => {
    if (Array.isArray(d.oauthProviders)) setOauthProviders(d.oauthProviders);
    if (Array.isArray(d.apiKeyProviders)) setApiKeyProviders(d.apiKeyProviders);
  }, []);

  const applyRuntime = useCallback((d: RuntimeReply) => {
    if (Array.isArray(d.catalog)) setCatalog(d.catalog);
    if (Array.isArray(d.builtIn)) setBuiltInRefs(new Set(d.builtIn));
    setRuntimeError(d.modelError ?? null);
  }, []);

  const applyScope = useCallback(({ ok, data: d }: JsonReply<ScopeReply>) => {
    if (!ok || d.error || !d.source) {
      setScopeError(d.error ?? t("models.scopeError"));
      return;
    }
    setScopeError(null);
    setScopeDoc(d);
  }, [t]);

  const refreshAuthProviders = useCallback(() => {
    return getJson<AuthProvidersReply>(settingsUrls.authProviders(cwd))
      .then((r) => applyAuthProviders(r.data))
      .catch(() => {});
  }, [cwd, applyAuthProviders]);

  const refreshRuntime = useCallback(() => {
    if (!cwd) {
      setCatalog([]);
      return;
    }
    return getJson<RuntimeReply>(settingsUrls.modelsRuntime(cwd))
      .then((r) => applyRuntime(r.data))
      .catch(() => {});
  }, [cwd, applyRuntime]);

  const refreshScope = useCallback(() => {
    if (!cwd) {
      setScopeDoc(null);
      return;
    }
    return getJson<ScopeReply>(settingsUrls.modelsPicker(cwd))
      .then(applyScope)
      .catch(() => setScopeError(t("models.scopeError")));
  }, [cwd, t, applyScope]);

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

  // Layout effect: with every source cached, the first painted frame is the finished page.
  useLayoutEffect(() => {
    let cancelled = false;
    const cachedConfig = peekJson<ModelsJson>(settingsUrls.modelsConfig);
    const cachedAuth = peekJson<AuthProvidersReply>(settingsUrls.authProviders(cwd));
    const cachedRuntime = cwd ? peekJson<RuntimeReply>(settingsUrls.modelsRuntime(cwd)) : undefined;
    const cachedScope = cwd ? peekJson<ScopeReply>(settingsUrls.modelsPicker(cwd)) : undefined;
    if (cachedConfig && cachedAuth && (!cwd || (cachedRuntime && cachedScope))) {
      applyConfig(cachedConfig.data);
      applyAuthProviders(cachedAuth.data);
      if (cachedRuntime) applyRuntime(cachedRuntime.data);
      if (cachedScope) applyScope(cachedScope);
      setLoading(false);
    }
    const configRequest = getJson<ModelsJson>(settingsUrls.modelsConfig)
      .then((r) => applyConfig(r.data))
      .catch((error) => setLoadError(String(error)));
    // No provider forms mount until all four inputs have settled. Otherwise
    // built-ins briefly look like disconnected custom endpoints.
    void Promise.all([configRequest, refreshAuthProviders(), refreshRuntime(), refreshScope()])
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, applyConfig, applyAuthProviders, applyRuntime, applyScope, refreshAuthProviders, refreshRuntime, refreshScope]);

  const configDirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
  useEffect(() => {
    configDirtyRef.current = configDirty;
    onDirtyChange?.(configDirty);
  }, [configDirty, onDirtyChange]);
  useEffect(() => {
    if (!configDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [configDirty]);

  const openProvider = useCallback((provider: string | null, model?: ModelRef) => {
    setView({ provider, ...(model ? { model } : {}) });
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

  const openAdd = useCallback(() => {
    // Without a loaded document there is no basis for choosing a mode, and a
    // wrong guess replaces the whole list. Refuse rather than guess.
    if (!cwd || !scopeDoc) return;
    setModelPick(scopeDoc.source === "none" ? "replace" : "add");
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
    if (view.provider && !savedConfig.providers?.[view.provider]
      && !catalog.some((model) => model.provider === view.provider)) {
      openProvider(null);
    } else if (view.provider) {
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
  // List entries that no longer resolve. Chat ignores them, but they still hold
  // the list back, so they must stay visible and removable.
  const unresolved = scopeDoc
    ? unresolvedPatterns({ patterns: scopeDoc.patterns, visible: [...listedRefs] })
      // An ambiguous entry is not "unavailable" — it resolves to several models
      // and needs the qualified form instead. It gets its own notice.
      .filter((pattern) => !(scopeDoc.ambiguous ?? []).includes(pattern))
    : [];

  const connectedIds = new Set([
    ...oauthProviders.filter((p) => p.loggedIn).map((p) => p.id),
    ...apiKeyProviders.filter((p) => p.configured).map((p) => p.id),
  ]);
  const selectedProviderId = view.provider;
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
  const inChatCount = (id: string) => chatRefs.filter((model) => model.provider === id).length;
  const providerDirty = (id: string) =>
    JSON.stringify(config.providers?.[id] ?? null) !== JSON.stringify(savedConfig.providers?.[id] ?? null);

  // ── Shared pieces ───────────────────────────────────────────────────────────

  /** A model row's main area: opens the model editor, with a chevron that says so. */
  const rowButton = (title: string, sub: string | undefined, tags: ReactNode, onClick: () => void) => (
    <button type="button" className="models-row-main models-row-button" title={t("models.editParams")} onClick={onClick}>
      <span className="models-row-text">
        <span className="models-row-title-line">
          <span className="models-row-title">{title}</span>
          {tags}
        </span>
        {sub && <code className="models-row-sub">{sub}</code>}
      </span>
      <svg className="models-row-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  );

  const chatSwitch = (ref: string, usable: boolean) => {
    if (!cwd || !scopeDoc) return null;
    const inChat = listedRefs.has(ref);
    return (
      <span className="models-row-switch">
        <ConfigSwitch
          checked={inChat}
          disabled={scopeDoc.readOnly || (!usable && !inChat)}
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

  // ── Chat list notices ───────────────────────────────────────────────────────

  /**
   * The chat list only speaks up when something needs attention; the counts in
   * the sidebar and the switches on each row already say what chat offers.
   */
  const renderScopeNotices = () => {
    if (!cwd) return <Notice>{t("models.scopeNoCwd")}</Notice>;
    if (!scopeDoc) return scopeError ? <Notice tone="danger">{scopeError}</Notice> : null;
    return (
      <>
        {scopeDoc.readOnly && <Notice tone="warning">{t("models.scopeReadOnly")}</Notice>}
        {scopeNotice && <Notice tone="info">{scopeNotice}</Notice>}
        {scopeError && <Notice tone="danger">{scopeError}</Notice>}
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
      </>
    );
  };

  // ── Providers ───────────────────────────────────────────────────────────────

  const renderProviderPage = (row: ProviderRow) => {
    const json = row.json;
    // OAuth/API-key providers ship with the SDK; their models.json entry only overrides.
    const builtIn = Boolean(row.oauth || row.apiKey);
    const showApiKey = row.apiKey && (!row.oauth || row.apiKey.configured || !row.oauth.loggedIn);
    const definitions = json?.models ?? [];
    const hasEndpointOverrides = Boolean(
      json && (
        (json.name && json.name.trim() !== "") ||
        Boolean(json.api) ||
        (json.baseUrl && json.baseUrl.trim() !== "") ||
        (json.apiKey && json.apiKey.trim() !== "") ||
        (json.headers && Object.keys(json.headers).length > 0)
      )
    );
    const isOverrideExpanded = expandedOverrides[row.id] ?? hasEndpointOverrides;
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
    const endpointSection = json && (
      <section className="models-section">
        <SectionHeading
          title={builtIn ? t("models.sectionEndpointOverride") : t("models.sectionEndpoint")}
          hint={builtIn ? t("models.sectionOverrideHint") : undefined}
          actions={builtIn ? (
            <ConfigButton
              size="small"
              variant="ghost"
              onClick={() => setExpandedOverrides((prev) => ({ ...prev, [row.id]: !isOverrideExpanded }))}
            >
              {isOverrideExpanded ? t("i18n.collapse") : t("i18n.expand")}
            </ConfigButton>
          ) : undefined}
        />
        {(!builtIn || isOverrideExpanded) && (
          <EndpointForm
            key={row.id}
            providerId={row.id}
            provider={json}
            builtIn={builtIn}
            namePlaceholder={row.oauth?.name ?? row.apiKey?.displayName ?? row.id}
            onChange={(next) => updateProvider(row.id, next)}
          />
        )}
      </section>
    );

    const activeAuthLabel = row.oauth?.loggedIn
      ? t("models.kindOAuth")
      : row.apiKey?.configured
        ? t("models.kindApiKey")
        : null;

    return (
      <div className="models-form">
        <header className="settings-detail-header">
          <h2 className="settings-detail-title models-provider-label"><ProviderIcon id={row.id} size={16} />{row.label}</h2>
          <div className="settings-detail-meta">
            {activeAuthLabel && <span className="config-scope-tag">{activeAuthLabel}</span>}
            {row.oauth && !row.apiKey && !row.oauth.loggedIn && (
              <span className="config-scope-tag">{t("models.kindOAuth")}</span>
            )}
            {json && <span className="config-scope-tag">{builtIn ? t("models.kindOverridden") : t("models.kindCustom")}</span>}
          </div>
        </header>

        {(row.oauth || showApiKey) && (
          <section className="models-section">
            <SectionHeading title={t("models.sectionConnection")} />
            {row.oauth && <OAuthDetail key={row.oauth.id} provider={row.oauth} onRefresh={refreshAuthAndRuntime} cwd={cwd} />}
            {showApiKey && row.apiKey && <ApiKeyDetail key={`${row.apiKey.id}-key`} provider={row.apiKey} onRefresh={refreshAuthAndRuntime} cwd={cwd} />}
          </section>
        )}

        {/* A custom provider is set up from its endpoint; a built-in one rarely needs its override. */}
        {!builtIn && endpointSection}
        <section className="models-section">
          <SectionHeading
            title={<CountedTitle label={t("models.sectionModelsTitle")} count={modelRows.length} />}
            hint={cwd && scopeDoc ? t("models.chatSwitchHint") : undefined}
            actions={json && (
              <>
                <ConfigButton size="small" disabled={!json.baseUrl?.trim()} title={json.baseUrl?.trim() ? undefined : t("models.discoveryNeedsBaseUrl")} onClick={() => setDiscoveryFor(row.id)}>
                  {t("models.discoveryFetch")}
                </ConfigButton>
                <ConfigButton size="small" onClick={() => addModel(row.id)}>{t("models.newModel")}</ConfigButton>
              </>
            )}
          />
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
                    {rowButton(
                      model.name && model.name !== model.id ? model.name : (model.id || t("models.untitledModel")),
                      model.name && model.name !== model.id ? model.id : undefined,
                      <>
                        {/* A definition with a shipped id replaces that model whole; say so. */}
                        {model.definition && builtInRefs.has(ref) ? (
                          <span className="models-tag is-warning" title={t("models.replacesBuiltInHint")}>{t("models.replacesBuiltIn")}</span>
                        ) : builtIn && model.definition && (
                          // Every model of a custom provider is a definition; only mark those added to a built-in provider.
                          <span className="models-tag">{t("models.kindDefinition")}</span>
                        )}
                        {!model.usable && <span className="models-tag is-warning">{t("models.notUsable")}</span>}
                        {scopeDoc?.pins[ref] && <span className="models-tag">{t("models.thinkingPin", { level: scopeDoc.pins[ref] })}</span>}
                      </>,
                      () => openProvider(row.id, model.ref),
                    )}
                    {model.id && chatSwitch(ref, model.usable)}
                  </div>
                );
              })}
            </div>
          )}
        </section>
        {builtIn && endpointSection}
        {json && (
          <SettingsGroup>
            <SettingsRow
              label={builtIn ? t("models.deleteOverride") : t("models.deleteEndpoint")}
              description={builtIn ? t("models.deleteOverrideDescription") : t("models.deleteEndpointDescription")}
            >
              <ConfigButton size="small" variant="danger" onClick={() => { deleteProvider(row.id); if (builtIn) openProvider(row.id); }}>
                {builtIn ? t("i18n.remove") : t("i18n.delete")}
              </ConfigButton>
            </SettingsRow>
          </SettingsGroup>
        )}
      </div>
    );
  };

  const renderModelPage = (row: ProviderRow, ref: ModelRef) => {
    const back = (
      <button type="button" data-settings-back className="models-breadcrumb" onClick={() => openProvider(row.id)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        <ProviderIcon id={row.id} size={13} />
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
          shadowsBuiltIn={builtInRefs.has(`${row.id}/${model.id}`)}
        />
      </>
    );
  };

  const renderProvidersTab = () => {
    const active = providerRows.find((row) => row.id === selectedProviderId);
    const model = active ? view.model : undefined;
    if (active) {
      return (
        <>
          {!model && <SettingsBackLink label={t("common.models")} onClick={() => openProvider(null)} />}
          {renderScopeNotices()}
          {model ? renderModelPage(active, model) ?? renderProviderPage(active) : renderProviderPage(active)}
        </>
      );
    }
    const connectedRows = providerRows.filter((row) => row.connected);
    const otherRows = providerRows.filter((row) => !row.connected);
    const authLabel = (row: ProviderRow) => row.oauth?.loggedIn
      ? t("models.kindOAuth")
      : row.apiKey?.configured
        ? t("models.kindApiKey")
        : row.json ? t("models.kindCustom") : t("models.notConnected");
    const item = (row: ProviderRow) => (
      <SettingsLinkRow
        key={row.id}
        label={<span className="models-provider-label"><ProviderIcon id={row.id} size={13} />{row.label}{providerDirty(row.id) && <span className="models-dirty-dot" title={t("models.unsavedProvider")} />}</span>}
        description={authLabel(row)}
        muted={!row.connected}
        onOpen={() => openProvider(row.id)}
      >
        {scopeDoc && row.models.length > 0 && (
          <span className="settings-row-status" title={t("models.inChatCount", { count: inChatCount(row.id), total: row.models.length })}>
            {t("models.inChatShort", { count: inChatCount(row.id), total: row.models.length })}
          </span>
        )}
      </SettingsLinkRow>
    );
    return (
      <>
        <div className="settings-toolbar">
          <span className="settings-toolbar-summary">{t("models.summary", { count: chatRefs.length })}</span>
          <span className="settings-toolbar-spacer" />
          <ConfigButton size="small" variant="ghost" onClick={() => openAdd()} disabled={!cwd || !scopeDoc || scopeDoc.readOnly}>
            {t("models.pickChatModels")}
          </ConfigButton>
          <ConfigButton size="small" onClick={() => setPickerOpen(true)}>{t("models.addProvider")}</ConfigButton>
        </div>
        {renderScopeNotices()}
        {providerRows.length === 0 ? (
          <ConfigEmptyState>{t("models.noProviders")}</ConfigEmptyState>
        ) : (
          <>
            {connectedRows.length > 0 && (
              <SettingsGroup title={<CountedTitle label={t("models.groupConnected")} count={connectedRows.length} />}>
                {connectedRows.map(item)}
              </SettingsGroup>
            )}
            {otherRows.length > 0 && (
              <SettingsGroup title={<CountedTitle label={t("models.groupNotConnected")} count={otherRows.length} />}>
                {otherRows.map(item)}
              </SettingsGroup>
            )}
          </>
        )}
      </>
    );
  };

  return (
    <>
    <ConfigPanelShell embedded={embedded} title={t("common.models")} closeLabel={t("i18n.close")} onClose={onClose}>
      <div className="models-body settings-scroll">
        <div key={loading ? "loading" : JSON.stringify(view)} className="settings-page">
          {loading ? <SettingsLoading label={t("i18n.loading")} /> : renderProvidersTab()}
        </div>
      </div>

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
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
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
        listedRefs={modelPick === "replace" ? new Set() : listedRefs}
        mode={modelPick}
        providerLabel={providerLabel}
        saving={scopeSaving}
        error={scopeError}
        onClose={() => setModelPick(null)}
        onApply={(refs) => {
          const mode = modelPick;
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
