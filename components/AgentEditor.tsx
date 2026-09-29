"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getJson, peekJson, settingsUrls } from "@/lib/settings-cache";
import type { ModelsData } from "@/lib/models-cache";
import { subagentProfileSources } from "@/lib/subagent-profile-precedence";
import { THINKING_LEVELS as THINKING_LEVEL_VALUES } from "@/lib/thinking-levels";
import type { SubagentProfile, SubagentScope, SubagentWritableScope } from "@/lib/subagents";
import {
  ConfigButton,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigSwitch,
  SettingsDetailPage,
  SettingsGroup,
  SettingsRow,
} from "./SettingsUi";
import { ModelSelector } from "./ModelSelector";
import { Select } from "./Select";

const TOOL_OPTIONS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const THINKING_OPTIONS = ["", ...THINKING_LEVEL_VALUES] as const;

export type EditableProfile = Omit<SubagentProfile, "scope" | "filePath">;
/**
 * view: read-only (an invalid file, or an inherited definition on the Project page); edit: the agent's effective definition,
 * where a built-in is saved as the user's global copy; create: a new global agent.
 */
type EditorMode = "view" | "edit" | "create";

/** What the user needs to know about where an agent comes from; storage layers stay hidden. */
type ProfileTag = "modified" | "project" | null;

export function profileTag([top, below]: readonly SubagentProfile[]): ProfileTag {
  if (!top) return null;
  if (top.scope === "project" || top.scope === "workspace") return "project";
  return top.scope === "global" && !top.disableStub && below?.scope === "builtin" ? "modified" : null;
}

/**
 * The file the form edits. A project/workspace stub only hides the agent there, so the form (global
 * configuration) edits the definition below it. Built-ins and the global stubs that disable them
 * are edited as the user's global copy.
 */
function editOwner([top, below]: readonly SubagentProfile[]): SubagentProfile {
  return top.disableStub && top.scope !== "global" ? below ?? top : top;
}

function editTarget(top: SubagentProfile): SubagentWritableScope | null {
  if (top.configurationError) return null;
  if (top.scope === "builtin" || (top.scope === "global" && top.disableStub)) return "global";
  return isWritableScope(top.scope) && !top.disableStub ? top.scope : null;
}

/** Form fields that Save writes; `enabled` is switched immediately and never makes the form dirty. */
function formSnapshot(profile: EditableProfile): string {
  return JSON.stringify({ ...profile, enabled: undefined });
}

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

export function shortenPath(path: string): string {
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

export interface AgentEditorOptions {
  cwd: string;
  profiles: readonly SubagentProfile[];
  /** Refetch the profile list after a write. */
  refresh: () => Promise<SubagentProfile[]>;
  /** Something was written: the caller flags "reload to apply" and refreshes its sibling pages. */
  onChanged: () => void;
  /**
   * The page's scope. The Project page passes "project": it only writes project files, and an
   * inherited definition is read-only until "customize". The Agents page passes nothing and picks
   * the scope per save.
   */
  fixedScope?: "project";
  /** The agent is gone for good (deleted with nothing to fall back to). */
  onGone?: () => void;
}

/** Everything one agent's editor needs: which agent, the draft, and what Save/Delete/switch write. */
export function useAgentEditor({ cwd, profiles, refresh, onChanged, fixedScope, onGone }: AgentEditorOptions) {
  const { t } = useI18n();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditableProfile>(EMPTY_PROFILE);
  const [mode, setMode] = useState<EditorMode>("view");
  const [targetScope, setTargetScope] = useState<SubagentWritableScope>(fixedScope ?? "global");
  const [baseline, setBaseline] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One agent per name. The highest-precedence file wins whole, matching pi-subagents.
  const sources = useMemo(
    () => selectedName ? subagentProfileSources(profiles, selectedName) : [],
    [profiles, selectedName],
  );
  const effective = sources[0] ?? null;
  const shadowed = sources.slice(1);
  const effectiveTag = profileTag(sources);
  /** A disable stub has no definition of its own, so show the one it hides. */
  const shown = effective?.disableStub ? shadowed[0] ?? effective : effective;

  const show = useCallback((list: readonly SubagentProfile[], name: string | null) => {
    setSelectedName(name);
    setError(null);
    if (!name) return;
    const found = subagentProfileSources(list, name);
    const [top, below] = found;
    if (!top) return;
    const owner = editOwner(found);
    // Availability as it is here: customizing must not silently turn a hidden agent back on.
    const next = { ...editableProfile(top.disableStub ? below ?? top : top), enabled: fixedScope ? top.enabled : owner.enabled };
    setDraft(next);
    setBaseline(formSnapshot(next));
    const target = editTarget(owner);
    // Invalid files are shown read-only: saving would rewrite them from a lossy parse.
    setMode(target && (!fixedScope || target === fixedScope) ? "edit" : "view");
    if (fixedScope) setTargetScope(fixedScope);
    else if (target) setTargetScope(target);
  }, [fixedScope]);

  const open = (name: string) => show(profiles, name);

  const beginCreate = () => {
    let name = "custom-agent";
    let suffix = 2;
    const taken = new Set(profiles.map((profile) => profile.name.toLowerCase()));
    while (taken.has(name)) name = `custom-agent-${suffix++}`;
    setSelectedName(null);
    setDraft({ ...EMPTY_PROFILE, name, displayName: name });
    setMode("create");
    setTargetScope(fixedScope ?? "global");
    setError(null);
  };

  const beginDuplicate = () => {
    if (!shown) return;
    setSelectedName(null);
    setDraft({
      ...editableProfile(shown),
      name: duplicateProfileName(shown.name, profiles),
      displayName: t("agents.copyName", { name: shown.displayName }),
      enabled: true,
    });
    setMode("create");
    setTargetScope(fixedScope ?? "global");
    setError(null);
  };

  const afterChange = async (name?: string) => {
    const next = await refresh();
    if (name) show(next, name.toLowerCase());
    onChanged();
  };

  const writing = mode === "create";
  const editing = mode !== "view";
  const disabled = !editing || saving || toggling;
  /** The definition this form starts from belongs to global or the built-ins, not to this project. */
  const inherited = sources.length > 0 && editTarget(editOwner(sources)) === "global";
  // The Agents page can save an inherited definition as this project's own copy instead. Not while
  // this project has a stub: it must come off first, or the copy would silently replace it.
  const projectStubbed = Boolean(effective?.disableStub && effective.scope !== "global");
  const canPickScope = !fixedScope && (writing || (mode === "edit" && inherited && !projectStubbed));
  const overriding = mode === "edit" && inherited && targetScope === "project";
  /** Save will write a new file (create, or a project copy of an inherited definition). */
  const pendingFile = writing || overriding;
  /** The Project page shows an inherited definition read-only until the user customizes it. */
  const canCustomize = Boolean(fixedScope) && mode === "view" && inherited;
  const dirty = pendingFile || formSnapshot(draft) !== baseline;
  // Only a real file has a path worth showing; a built-in or a disable stub is just "the default".
  const displayedPath = pendingFile
    ? targetScope === "global"
      ? `~/.pi/agent/agents/${draft.name || "..."}.md`
      : `./.pi/agents/${draft.name || "..."}.md`
    : effective && !effective.disableStub
      ? displayProfilePath(effective, cwd)
      : null;
  const fullPath = pendingFile ? displayedPath : effective?.filePath ?? displayedPath;
  /** This project keeps its own copy of an agent that also exists globally (or as a built-in). */
  const followsOwnCopy = !writing && effective?.scope === "project" && !effective.disableStub && shadowed.length > 0;
  const removable = !writing && effective != null && isWritableScope(effective.scope) && !effective.disableStub
    && (!fixedScope || effective.scope === fixedScope);
  /** On the Project page the switch is availability here; with nothing of this project's own it cannot turn a globally-off agent on. */
  const enableBlocked = Boolean(fixedScope) && effective != null && !effective.enabled && effective.scope !== "project";

  const update = <K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const beginCustomize = () => {
    setMode("edit");
    setTargetScope("project");
  };

  const save = async () => {
    if (mode === "create" && profiles.some((profile) => profile.name.toLowerCase() === draft.name.trim().toLowerCase())) {
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
    const message = !fallback
      ? t("agents.deleteConfirm", { name: shown.displayName })
      : effective.scope !== "project" && fallback.scope === "builtin"
        ? t("agents.restoreDefaultConfirm", { name: shown.displayName })
        : t("agents.restoreGlobalConfirm", { name: shown.displayName });
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
      if (!fallback) onGone?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  /** The switch always means "can the model call this agent here"; the server picks which file to touch. */
  const setEnabled = async (name: string, enabled: boolean) => {
    setToggling(true);
    setError(null);
    try {
      const response = await fetch("/api/subagents/profiles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fixedScope ? { cwd, name, projectEnabled: enabled } : { cwd, name, enabled }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      // Refresh the list but keep unsaved form edits.
      await refresh();
      if (name === selectedName) update("enabled", enabled);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setToggling(false);
    }
  };

  const toggleEnabled = async (enabled: boolean) => {
    if (pendingFile) {
      update("enabled", enabled);
      return;
    }
    if (effective) await setEnabled(effective.name, enabled);
  };

  return {
    cwd, fixedScope, mode, draft, targetScope, error, saving, savedOk, toggling,
    effective, shadowed, shown, effectiveTag,
    writing, editing, disabled, canPickScope, overriding, pendingFile, canCustomize, dirty,
    displayedPath, fullPath, followsOwnCopy, removable, enableBlocked,
    setTargetScope, setError, update, open, show, beginCreate, beginDuplicate, beginCustomize,
    save, remove, setEnabled, toggleEnabled,
  };
}

export type AgentEditor = ReturnType<typeof useAgentEditor>;

/** Model choices for the runtime field; the last reply paints at once, then revalidates. */
function useModelOptions(cwd: string) {
  const seed = peekJson<Partial<ModelsData> & { error?: string }>(settingsUrls.chatModels(cwd));
  const seeded = seed?.ok && !seed.data.error ? seed.data.modelList : undefined;
  const [options, setOptions] = useState<ModelsData["modelList"]>(seeded ?? []);
  const [loading, setLoading] = useState(!seeded);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void (async () => {
      try {
        const response = await getJson<Partial<ModelsData> & { error?: string }>(settingsUrls.chatModels(cwd));
        if (controller.signal.aborted) return;
        const data = response.data;
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setOptions(data.modelList ?? []);
        setError(data.modelError ?? null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [cwd]);
  return { options, loading, error };
}

/** The Save button for the editor, shown while the form is editable. */
export function AgentSaveFooter({ editor }: { editor: AgentEditor }) {
  const { t } = useI18n();
  if (!editor.editing) return null;
  return (
    <ConfigFooter status={editor.error && <span role="alert" className="settings-row-message is-error">{editor.error}</span>}>
      <ConfigButton
        variant="primary"
        onClick={() => void editor.save()}
        disabled={editor.saving || editor.savedOk || editor.toggling || !editor.dirty || !editor.draft.name.trim()}
        className={editor.savedOk ? "is-success" : undefined}
      >
        {editor.savedOk && (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="config-button-success-icon">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        <span>{editor.savedOk ? t("i18n.saved") : editor.saving ? t("agents.saving") : t("agents.save")}</span>
      </ConfigButton>
    </ConfigFooter>
  );
}

/** One agent's detail page: header, switch, and the profile form. */
export function AgentDetail({ editor }: { editor: AgentEditor }) {
  const { t } = useI18n();
  const models = useModelOptions(editor.cwd);
  const {
    draft, mode, effective, shadowed, shown, effectiveTag, writing, disabled, saving, toggling,
    canPickScope, overriding, pendingFile, displayedPath, fullPath, followsOwnCopy, removable, fixedScope, update,
  } = editor;
  const modelSelectorOptions = useMemo(() => models.options.map((model) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
  })), [models.options]);
  if (!effective && mode !== "create") return <ConfigEmptyState>{t("agents.empty")}</ConfigEmptyState>;

  const selectedModelAvailable = !draft.model || models.options.some((model) => `${model.provider}/${model.id}` === draft.model);
  const selectedModel = (() => {
    if (!draft.model) return null;
    const separator = draft.model.indexOf("/");
    return separator < 0
      ? { provider: "", modelId: draft.model }
      : { provider: draft.model.slice(0, separator), modelId: draft.model.slice(separator + 1) };
  })();
  const profileTitle = mode === "create" ? t("agents.new") : draft.displayName || draft.name;
  const sourceNotes = !writing && effective ? [
    ...(effective.disableStub && effective.scope !== "global" ? [t("agents.stubNote")] : []),
  ] : [];
  const restoresDefault = shadowed[0]?.scope === "builtin";
  const enabledChecked = pendingFile ? draft.enabled : Boolean(effective?.enabled);

  return (
    <SettingsDetailPage
      title={profileTitle}
      meta={(
        <>
          {!writing && effectiveTag && (
            <span className={`config-scope-tag${effectiveTag === "project" ? " is-project" : ""}`}>
              {effectiveTag === "modified" ? t("agents.tag.modified") : t("agents.tag.project")}
            </span>
          )}
          {displayedPath && <span title={fullPath ?? undefined} className="config-detail-path">{displayedPath}</span>}
        </>
      )}
      description={sourceNotes.length > 0 && (
        <span className="agents-source-note">
          {sourceNotes.map((note) => <span key={note}>{note}</span>)}
        </span>
      )}
    >
      {followsOwnCopy && (
        <SettingsGroup>
          <SettingsRow label={t("agents.ownCopyTitle")} description={t("agents.ownCopyDescription")}>
            <ConfigButton size="small" onClick={() => void editor.remove()} disabled={saving || toggling}>
              {t("agents.restoreGlobal")}
            </ConfigButton>
          </SettingsRow>
        </SettingsGroup>
      )}
      {editor.canCustomize && (
        <SettingsGroup>
          <SettingsRow label={t("agents.inheritedTitle")} description={t("agents.inheritedDescription")}>
            <ConfigButton size="small" onClick={editor.beginCustomize} disabled={saving || toggling}>
              {t("agents.customize")}
            </ConfigButton>
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsGroup>
        <SettingsRow
          label={t("agents.enabled")}
          description={fixedScope || (effectiveTag === "project" && !writing) || overriding
            ? t("agents.enabledProjectDescription")
            : t("agents.enabledDescription")}
        >
          <ConfigSwitch
            checked={enabledChecked}
            disabled={saving || toggling || (!writing && Boolean(effective?.configurationError)) || (!pendingFile && editor.enableBlocked)}
            label={enabledChecked ? t("agents.disable") : t("agents.enable")}
            onChange={(value) => void editor.toggleEnabled(value)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("agents.profile")}>
        <div className="settings-form">
          {canPickScope && (
            <Field label={t("agents.saveLocation")}>
              <Select
                ariaLabel={t("agents.saveLocation")}
                value={editor.targetScope}
                disabled={disabled}
                onChange={(value) => editor.setTargetScope(value as SubagentWritableScope)}
                options={[
                  { value: "global", label: t("agents.saveLocation.global") },
                  { value: "project", label: writing ? t("agents.saveLocation.project") : t("agents.saveLocation.override") },
                ]}
              />
              {overriding && <span className="settings-row-message">{t("agents.overrideNote")}</span>}
            </Field>
          )}
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
                emptyLabel={models.loading ? t("agents.modelsLoading") : t("agents.inherit")}
                selectedLabel={draft.model && !selectedModelAvailable ? t("agents.modelUnavailable", { model: draft.model }) : undefined}
                disabled={disabled || models.loading || (models.options.length === 0 && !draft.model)}
                ariaLabel={t("agents.model")}
                variant="field"
                placement="auto"
              />
              {models.error && <span className="settings-row-message is-error">{models.error}</span>}
            </Field>
            <Field label={t("agents.thinking")}>
              <Select
                ariaLabel={t("agents.thinking")}
                value={draft.thinking ?? ""}
                disabled={disabled}
                onChange={(value) => update("thinking", (value || undefined) as EditableProfile["thinking"])}
                options={THINKING_OPTIONS.map((value) => ({ value, label: value || t("agents.inherit") }))}
              />
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

      {shown && !writing && (
        <SettingsGroup>
          <SettingsRow label={t("agents.duplicate")} description={t("agents.duplicateDescription")}>
            <ConfigButton size="small" onClick={editor.beginDuplicate} disabled={saving || toggling}>{t("agents.duplicate")}</ConfigButton>
          </SettingsRow>
          {removable && !followsOwnCopy && (
            <SettingsRow
              label={!shadowed[0] ? t("agents.deleteTitle") : restoresDefault ? t("agents.restoreDefault") : t("agents.restoreGlobal")}
              description={!shadowed[0] ? t("agents.deleteDescription") : restoresDefault ? t("agents.restoreDefaultDescription") : t("agents.restoreGlobalDescription")}
            >
              <ConfigButton variant="danger" size="small" onClick={() => void editor.remove()} disabled={saving || toggling}>
                {!shadowed[0] ? t("agents.delete") : restoresDefault ? t("agents.restoreDefault") : t("agents.restoreGlobal")}
              </ConfigButton>
            </SettingsRow>
          )}
        </SettingsGroup>
      )}
    </SettingsDetailPage>
  );
}
