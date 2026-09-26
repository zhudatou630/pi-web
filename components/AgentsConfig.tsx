"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getJson, peekJson, settingsUrls, type JsonReply } from "@/lib/settings-cache";
import type { SubagentProfilesResponse, SubagentSettingsResponse } from "@/lib/api-types";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ModelsData } from "@/lib/models-cache";
import { subagentProfileSources } from "@/lib/subagent-profile-precedence";
import { THINKING_LEVELS as THINKING_LEVEL_VALUES } from "@/lib/thinking-levels";
import type { SubagentProfile, SubagentScope, SubagentWritableScope } from "@/lib/subagents";
import {
  ConfigButton,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigPanelShell,
  ConfigSwitch,
  CountedTitle,
  SettingsBackLink,
  SettingsDetailPage,
  SettingsGroup,
  SettingsLinkRow,
  SettingsLoading,
  SettingsRow,
} from "./SettingsUi";
import { ModelSelector } from "./ModelSelector";

const TOOL_OPTIONS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const THINKING_OPTIONS = ["", ...THINKING_LEVEL_VALUES] as const;

type EditableProfile = Omit<SubagentProfile, "scope" | "filePath">;
/** view: read-only built-in or disable stub; edit: the effective file in place; create: new name; customize: copy a built-in to a file. */
type EditorMode = "view" | "edit" | "create" | "customize";

const EMPTY_PROFILE: EditableProfile = {
  name: "custom-agent",
  displayName: "Custom agent",
  description: "",
  systemPrompt: "",
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  loadSkills: false,
  loadExtensions: false,
  inheritContext: false,
  runInBackground: true,
  enabled: true,
};

function editableProfile(profile: SubagentProfile): EditableProfile {
  return {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    tools: [...profile.tools],
    loadSkills: profile.loadSkills,
    loadExtensions: profile.loadExtensions,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinking ? { thinking: profile.thinking } : {}),
    ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
    inheritContext: profile.inheritContext,
    runInBackground: profile.runInBackground,
    enabled: profile.enabled,
  };
}

function duplicateProfileName(name: string, profiles: readonly SubagentProfile[]): string {
  const existing = new Set(profiles.map((profile) => profile.name.toLowerCase()));
  const base = `${name}-copy`;
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase())) candidate = `${base}-${suffix++}`;
  return candidate;
}

function isWritableScope(scope: SubagentScope): scope is SubagentWritableScope {
  return scope !== "builtin";
}

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function displayProfilePath(profile: SubagentProfile, cwd: string): string | null {
  if (!profile.filePath) return null;
  if ((profile.scope === "project" || profile.scope === "workspace") && profile.filePath.startsWith(cwd)) {
    const relative = profile.filePath.slice(cwd.length).replace(/^[/\\]/, "");
    return `./${relative}`;
  }
  return shortenPath(profile.filePath);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <ConfigField label={label}>{children}</ConfigField>;
}

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="settings-checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

export function AgentsConfig({
  cwd,
  sessionId = null,
  onClose,
  onReloaded,
  embedded = false,
}: {
  cwd: string;
  sessionId?: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  // The last replies paint at once; the mount loads then revalidate them.
  const [seed] = useState(() => {
    const ok = <T,>(reply: JsonReply<T & { error?: string }> | undefined) => reply?.ok && !reply.data.error ? reply.data : undefined;
    const settings = ok(peekJson<Partial<SubagentSettingsResponse> & { error?: string }>(settingsUrls.subagentSettings));
    return {
      profiles: ok(peekJson<Partial<SubagentProfilesResponse> & { error?: string }>(settingsUrls.subagentProfiles(cwd)))?.profiles,
      settings: typeof settings?.enabled === "boolean" ? settings : undefined,
      models: ok(peekJson<Partial<ModelsData> & { error?: string }>(settingsUrls.chatModels(cwd)))?.modelList,
    };
  });
  const [profiles, setProfiles] = useState<SubagentProfile[]>(seed.profiles ?? []);
  const [modelOptions, setModelOptions] = useState<ModelsData["modelList"]>(seed.models ?? []);
  const [modelsLoading, setModelsLoading] = useState(!seed.models);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [page, setPage] = useState<"list" | "detail">("list");
  const [draft, setDraft] = useState<EditableProfile>(EMPTY_PROFILE);
  const [mode, setMode] = useState<EditorMode>("view");
  const [targetScope, setTargetScope] = useState<SubagentWritableScope>("project");
  const [loading, setLoading] = useState(!seed.profiles);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [builtInEnabled, setBuiltInEnabled] = useState(seed.settings?.enabled ?? true);
  const [maxConcurrent, setMaxConcurrent] = useState(seed.settings?.maxConcurrent ?? 10);
  const [settingsLoading, setSettingsLoading] = useState(!seed.settings);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [reloading, setReloading] = useState(false);

  // One agent per name. The highest-precedence file wins whole, matching pi-subagents.
  const sources = useMemo(
    () => selectedName ? subagentProfileSources(profiles, selectedName) : [],
    [profiles, selectedName],
  );
  const effective = sources[0] ?? null;
  const shadowed = sources.slice(1);
  /** A disable stub has no definition of its own, so show the one it hides. */
  const shown = effective?.disableStub ? shadowed[0] ?? effective : effective;
  const rows = useMemo(() => [...new Set(profiles.map((profile) => profile.name.toLowerCase()))]
    .map((name) => {
      const [top, below] = subagentProfileSources(profiles, name);
      const shownProfile = top.disableStub ? below ?? top : top;
      return { name, top, label: shownProfile.displayName, description: shownProfile.description };
    })
    .sort((a, b) => a.label.localeCompare(b.label)), [profiles]);
  const modelSelectorOptions = useMemo(() => modelOptions.map((model) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
  })), [modelOptions]);

  const showAgent = useCallback((list: readonly SubagentProfile[], name: string | null) => {
    setSelectedName(name);
    setError(null);
    if (!name) return;
    const [top, below] = subagentProfileSources(list, name);
    if (!top) return;
    setDraft(editableProfile(top.disableStub ? below ?? top : top));
    // Invalid files are shown read-only: saving would rewrite them from a lossy parse.
    const editable = isWritableScope(top.scope) && !top.disableStub && !top.configurationError;
    setMode(editable ? "edit" : "view");
    if (editable) setTargetScope(top.scope as SubagentWritableScope);
  }, []);

  const fetchProfiles = useCallback(async () => {
    const response = await getJson<Partial<SubagentProfilesResponse> & { error?: string }>(settingsUrls.subagentProfiles(cwd));
    const data = response.data;
    if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
    const next = data.profiles ?? [];
    setProfiles(next);
    return next;
  }, [cwd]);

  const loadProfiles = useCallback(async (preferredName?: string) => {
    setError(null);
    try {
      const next = await fetchProfiles();
      // The page opens on the list; only a save or restore re-selects the item it touched.
      if (preferredName) showAgent(next, preferredName.toLowerCase());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [fetchProfiles, showAgent]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    const controller = new AbortController();
    setSettingsError(null);
    void (async () => {
      try {
        const response = await getJson<Partial<SubagentSettingsResponse> & { error?: string }>(settingsUrls.subagentSettings);
        if (controller.signal.aborted) return;
        const data = response.data;
        if (!response.ok || data.error || typeof data.enabled !== "boolean") {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        setBuiltInEnabled(data.enabled);
        if (typeof data.maxConcurrent === "number") setMaxConcurrent(data.maxConcurrent);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setSettingsError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setSettingsLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setModelsError(null);
    void (async () => {
      try {
        const response = await getJson<Partial<ModelsData> & { error?: string }>(settingsUrls.chatModels(cwd));
        if (controller.signal.aborted) return;
        const data = response.data;
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setModelOptions(data.modelList ?? []);
        setModelsError(data.modelError ?? null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setModelsError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setModelsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [cwd]);

  const beginCreate = () => {
    let name = "custom-agent";
    let suffix = 2;
    while (rows.some((row) => row.name === name)) name = `custom-agent-${suffix++}`;
    setSelectedName(null);
    setDraft({ ...EMPTY_PROFILE, name, displayName: name });
    setMode("create");
    setTargetScope("project");
    setError(null);
  };

  const beginDuplicate = () => {
    if (!shown) return;
    const name = duplicateProfileName(shown.name, profiles);
    setSelectedName(null);
    setDraft({
      ...editableProfile(shown),
      name,
      displayName: t("agents.copyName", { name: shown.displayName }),
      enabled: true,
    });
    setMode("create");
    setTargetScope("project");
    setError(null);
  };

  const beginCustomize = () => {
    if (!shown) return;
    setDraft(editableProfile(shown));
    setMode("customize");
    setTargetScope("project");
    setError(null);
  };

  const afterChange = async (name?: string) => {
    await loadProfiles(name);
    setReloadNeeded(Boolean(sessionId));
  };

  const save = async () => {
    if (mode === "create" && rows.some((row) => row.name === draft.name.trim().toLowerCase())) {
      setError(t("agents.nameExists", { name: draft.name.trim() }));
      return;
    }
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const response = await fetch("/api/subagents/profiles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: targetScope, profile: draft }),
      });
      const data = await response.json() as { profile?: SubagentProfile; error?: string };
      if (!response.ok || data.error || !data.profile) throw new Error(data.error ?? `HTTP ${response.status}`);
      await afterChange(data.profile.name);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!effective || !shown || !isWritableScope(effective.scope)) return;
    const fallback = shadowed[0];
    const message = fallback
      ? t("agents.restoreConfirm", { name: shown.displayName, scope: t(`agents.scope.${fallback.scope}`) })
      : t("agents.deleteConfirm", { name: shown.displayName });
    if (!window.confirm(message)) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/subagents/profiles", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: effective.scope, name: effective.name }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      await afterChange(fallback ? effective.name : undefined);
      if (!fallback) setPage("list");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const writing = mode === "create" || mode === "customize";
  const editing = mode !== "view";
  const disabled = !editing || saving || toggling;
  const displayedScope = writing ? targetScope : effective?.scope;
  const displayedPath = writing
    ? targetScope === "global"
      ? `~/.pi/agent/agents/${draft.name || "..."}.md`
      : `./.pi/agents/${draft.name || "..."}.md`
    : effective
      ? displayProfilePath(effective, cwd) ?? t("agents.builtinPath")
      : "";
  const fullPath = writing ? displayedPath : effective?.filePath ?? displayedPath;
  const selectedModelAvailable = !draft.model || modelOptions.some((model) => `${model.provider}/${model.id}` === draft.model);
  const selectedModel = (() => {
    if (!draft.model) return null;
    const separator = draft.model.indexOf("/");
    return separator < 0
      ? { provider: "", modelId: draft.model }
      : { provider: draft.model.slice(0, separator), modelId: draft.model.slice(separator + 1) };
  })();
  const update = <K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  /** The switch always means "can the model call this agent here"; the server picks which file to touch. */
  const setAgentEnabled = async (name: string, enabled: boolean) => {
    setToggling(true);
    setError(null);
    try {
      const response = await fetch("/api/subagents/profiles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, name, enabled }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      // Refresh the list but keep unsaved form edits.
      await fetchProfiles();
      if (name === selectedName) update("enabled", enabled);
      setReloadNeeded(Boolean(sessionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setToggling(false);
    }
  };

  const toggleEnabled = async (enabled: boolean) => {
    if (writing) {
      update("enabled", enabled);
      return;
    }
    if (effective) await setAgentEnabled(effective.name, enabled);
  };

  const toggleBuiltInSubagents = async (enabled: boolean) => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const response = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!response.ok || data.error || typeof data.enabled !== "boolean") {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setBuiltInEnabled(data.enabled);
      setReloadNeeded(Boolean(sessionId));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsSaving(false);
    }
  };

  const updateMaxConcurrent = async (value: number) => {
    setMaxConcurrent(value);
    setSettingsError(null);
    try {
      const response = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent: value }),
      });
      const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!response.ok || data.error || typeof data.maxConcurrent !== "number") {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setMaxConcurrent(data.maxConcurrent);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const reloadSession = async () => {
    if (!sessionId) return;
    setReloading(true);
    setSettingsError(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      setReloadNeeded(false);
      onReloaded?.();
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReloading(false);
    }
  };

  const profileTitle = mode === "create" ? t("agents.new") : draft.displayName || draft.name;
  const sourceNotes = !writing && effective ? [
    ...(effective.disableStub ? [t("agents.stubNote")] : []),
    ...shadowed.map((source) => source.scope === "builtin"
      ? t("agents.overridesBuiltin")
      : t("agents.shadows", { scope: t(`agents.scope.${source.scope}`), path: displayProfilePath(source, cwd) ?? "" })),
  ] : [];
  const enabledChecked = writing ? draft.enabled : Boolean(effective?.enabled);
  const removable = !writing && effective && isWritableScope(effective.scope) && !effective.disableStub;

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.agents")} subtitle={shortenPath(cwd)} closeLabel={t("agents.close")} onClose={onClose}>
      {reloadNeeded && sessionId && (
        <div className="agents-feature-setting is-notice">
          <span role="status" className="agents-feature-reload-notice">{t("agents.reloadRequired")}</span>
          <ConfigButton size="small" onClick={() => void reloadSession()} disabled={reloading || settingsSaving}>
            {reloading ? t("agents.reloading") : t("agents.reloadSession")}
          </ConfigButton>
        </div>
      )}
      <div className="settings-scroll">
        <div key={loading ? "loading" : page} className="settings-page">
          {page === "list" ? (
            <>
              <SettingsGroup>
                <SettingsRow label={t("agents.builtInTitle")} description={t("agents.builtInDescription")}>
                  <ConfigSwitch
                    checked={builtInEnabled}
                    disabled={settingsLoading || reloading}
                    loading={settingsSaving}
                    label={t("agents.builtInTitle")}
                    onChange={(enabled) => void toggleBuiltInSubagents(enabled)}
                  />
                </SettingsRow>
                <SettingsRow label={t("agents.maxConcurrent")} description={t("agents.maxConcurrentDescription")}>
                  <input
                    aria-label={t("agents.maxConcurrent")}
                    className="settings-inline-input agents-number-input"
                    type="number"
                    min={1}
                    max={32}
                    value={maxConcurrent}
                    disabled={settingsLoading || settingsSaving}
                    onChange={(event) => setMaxConcurrent(Number(event.target.value))}
                    onBlur={() => void updateMaxConcurrent(maxConcurrent)}
                  />
                </SettingsRow>
                {settingsError && <p role="alert" className="settings-row-message is-error">{settingsError}</p>}
              </SettingsGroup>

              <SettingsGroup
                title={<CountedTitle label={t("agents.profiles")} count={rows.length} />}
                action={<ConfigButton size="small" onClick={() => { beginCreate(); setPage("detail"); }}>{t("agents.new")}</ConfigButton>}
              >
                {error && <p role="alert" className="settings-row-message is-error">{error}</p>}
                {loading ? (
                  <SettingsLoading label={t("agents.loading")} />
                ) : rows.map(({ name, top, label, description }) => (
                  <SettingsLinkRow
                    key={name}
                    label={<>{label}<span className="settings-row-tag">{t(`agents.scope.${top.scope}`)}</span></>}
                    description={description}
                    muted={!top.enabled}
                    title={top.filePath}
                    onOpen={() => { showAgent(profiles, name); setPage("detail"); }}
                  >
                    <ConfigSwitch
                      checked={top.enabled}
                      disabled={toggling || Boolean(top.configurationError)}
                      label={top.enabled ? t("agents.disable") : t("agents.enable")}
                      onChange={(value) => void setAgentEnabled(top.name, value)}
                    />
                  </SettingsLinkRow>
                ))}
              </SettingsGroup>
            </>
          ) : (
            <>
              <SettingsBackLink label={t("common.agents")} onClick={() => { setPage("list"); setError(null); }} />
              {!effective && mode !== "create" ? (
                <ConfigEmptyState>{t("agents.empty")}</ConfigEmptyState>
              ) : (
                <SettingsDetailPage
                  title={profileTitle}
                  meta={(
                    <>
                      {displayedScope && (
                        <span className={`config-scope-tag${displayedScope === "project" ? " is-project" : ""}`}>
                          {t(`agents.scope.${displayedScope}`)}
                        </span>
                      )}
                      {displayedScope !== "builtin" && <span title={fullPath} className="config-detail-path">{displayedPath}</span>}
                    </>
                  )}
                  description={sourceNotes.length > 0 && (
                    <span className="agents-source-note">
                      {sourceNotes.map((note) => <span key={note}>{note}</span>)}
                    </span>
                  )}
                >
                  <SettingsGroup>
                    <SettingsRow label={t("agents.enabled")} description={t("agents.enabledDescription")}>
                      <ConfigSwitch
                        checked={enabledChecked}
                        disabled={saving || toggling || (!writing && Boolean(effective?.configurationError))}
                        label={enabledChecked ? t("agents.disable") : t("agents.enable")}
                        onChange={(value) => void toggleEnabled(value)}
                      />
                    </SettingsRow>
                    {effective?.scope === "builtin" && mode === "view" && (
                      <SettingsRow label={t("agents.customize")} description={t("agents.customizeDescription")}>
                        <ConfigButton size="small" onClick={beginCustomize} disabled={saving || toggling}>{t("agents.customize")}</ConfigButton>
                      </SettingsRow>
                    )}
                    {writing && (
                      <SettingsRow label={t("agents.saveScope")} description={t("agents.saveScopeDescription")}>
                        <div role="radiogroup" aria-label={t("agents.saveScope")} className="settings-segmented">
                          {(["global", "project"] as const).map((scope) => (
                            <button
                              key={scope}
                              type="button"
                              role="radio"
                              aria-checked={targetScope === scope}
                              className="settings-segmented-option"
                              onClick={() => setTargetScope(scope)}
                              disabled={saving}
                            >
                              {t(`agents.scope.${scope}`)}
                            </button>
                          ))}
                        </div>
                      </SettingsRow>
                    )}
                  </SettingsGroup>

                  <SettingsGroup title={t("agents.profile")}>
                    <div className="settings-form">
                      <div className="settings-form-pair">
                        <Field label={t("agents.name")}>
                          {mode === "create" ? (
                            <input aria-label={t("agents.name")} value={draft.name} disabled={disabled} onChange={(event) => update("name", event.target.value)} />
                          ) : (
                            <code className="settings-form-value">{draft.name}</code>
                          )}
                        </Field>
                        <Field label={t("agents.displayName")}>
                          <input aria-label={t("agents.displayName")} value={draft.displayName} disabled={disabled} onChange={(event) => update("displayName", event.target.value)} />
                        </Field>
                      </div>
                      <Field label={t("agents.description")}>
                        <input aria-label={t("agents.description")} value={draft.description} disabled={disabled} onChange={(event) => update("description", event.target.value)} />
                      </Field>
                      <Field label={t("agents.prompt")}>
                        <textarea className="agents-system-prompt" aria-label={t("agents.prompt")} value={draft.systemPrompt} disabled={disabled} onChange={(event) => update("systemPrompt", event.target.value)} />
                      </Field>
                    </div>
                  </SettingsGroup>

                  <SettingsGroup title={t("agents.capabilities")}>
                    <div className="settings-form">
                      <Field label={t("agents.tools")}>
                        <div className="settings-checkbox-grid">
                          {TOOL_OPTIONS.map((tool) => (
                            <Toggle key={tool} label={tool} disabled={disabled} checked={draft.tools.includes(tool)} onChange={(checked) => update("tools", checked ? [...draft.tools, tool] : draft.tools.filter((item) => item !== tool))} />
                          ))}
                        </div>
                      </Field>
                      <Field label={t("agents.resources")}>
                        <div className="settings-checkbox-grid">
                          <Toggle label={t("agents.loadSkills")} disabled={disabled} checked={draft.loadSkills} onChange={(checked) => update("loadSkills", checked)} />
                          <Toggle label={t("agents.loadExtensions")} disabled={disabled} checked={draft.loadExtensions} onChange={(checked) => update("loadExtensions", checked)} />
                        </div>
                      </Field>
                    </div>
                  </SettingsGroup>

                  <SettingsGroup title={t("agents.runtime")}>
                    <div className="settings-form">
                      <div className="settings-form-triple">
                        <Field label={t("agents.model")}>
                          <ModelSelector
                            options={modelSelectorOptions}
                            value={selectedModel}
                            onChange={(provider, modelId) => update("model", `${provider}/${modelId}`)}
                            onClear={() => update("model", undefined)}
                            emptyLabel={modelsLoading ? t("agents.modelsLoading") : t("agents.inherit")}
                            selectedLabel={draft.model && !selectedModelAvailable ? t("agents.modelUnavailable", { model: draft.model }) : undefined}
                            disabled={disabled || modelsLoading || (modelOptions.length === 0 && !draft.model)}
                            ariaLabel={t("agents.model")}
                            variant="field"
                            placement="auto"
                          />
                          {modelsError && <span className="settings-row-message is-error">{modelsError}</span>}
                        </Field>
                        <Field label={t("agents.thinking")}>
                          <select aria-label={t("agents.thinking")} value={draft.thinking ?? ""} disabled={disabled} onChange={(event) => update("thinking", (event.target.value || undefined) as EditableProfile["thinking"])}>
                            {THINKING_OPTIONS.map((value) => <option key={value || "default"} value={value}>{value || t("agents.inherit")}</option>)}
                          </select>
                        </Field>
                        <Field label={t("agents.maxTurns")}>
                          <input aria-label={t("agents.maxTurns")} type="number" min={1} value={draft.maxTurns ?? ""} disabled={disabled} onChange={(event) => update("maxTurns", event.target.value ? Number(event.target.value) : undefined)} />
                        </Field>
                      </div>
                      <div className="settings-checkbox-grid">
                        <Toggle label={t("agents.inheritContext")} disabled={disabled} checked={draft.inheritContext} onChange={(checked) => update("inheritContext", checked)} />
                        <Toggle label={t("agents.background")} disabled={disabled} checked={draft.runInBackground} onChange={(checked) => update("runInBackground", checked)} />
                      </div>
                    </div>
                  </SettingsGroup>

                  {(shown && !writing) && (
                    <SettingsGroup>
                      <SettingsRow label={t("agents.duplicate")} description={t("agents.duplicateDescription")}>
                        <ConfigButton size="small" onClick={beginDuplicate} disabled={saving || toggling}>{t("agents.duplicate")}</ConfigButton>
                      </SettingsRow>
                      {removable && (
                        <SettingsRow
                          label={shadowed[0] ? t("agents.restore", { scope: t(`agents.scope.${shadowed[0].scope}`) }) : t("agents.deleteTitle")}
                          description={shadowed[0] ? t("agents.restoreDescription") : t("agents.deleteDescription")}
                        >
                          <ConfigButton variant="danger" size="small" onClick={() => void remove()} disabled={saving || toggling}>
                            {shadowed[0] ? t("agents.restore", { scope: t(`agents.scope.${shadowed[0].scope}`) }) : t("agents.delete")}
                          </ConfigButton>
                        </SettingsRow>
                      )}
                    </SettingsGroup>
                  )}
                </SettingsDetailPage>
              )}
            </>
          )}
        </div>
      </div>
      {page === "detail" && editing && (
      <ConfigFooter status={error && <span role="alert" className="settings-row-message is-error">{error}</span>}>
        {(
          <ConfigButton
            variant="primary"
            onClick={() => void save()}
            disabled={saving || savedOk || toggling || !draft.name.trim()}
            className={savedOk ? "is-success" : undefined}
          >
            {savedOk && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="config-button-success-icon">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            <span>{savedOk ? t("i18n.saved") : saving ? t("agents.saving") : t("agents.save")}</span>
          </ConfigButton>
        )}
      </ConfigFooter>
      )}
    </ConfigPanelShell>
  );
}
