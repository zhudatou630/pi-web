"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getJson, peekJson, settingsUrls, type JsonReply } from "@/lib/settings-cache";
import type { SubagentProfilesResponse, SubagentSettingsResponse } from "@/lib/api-types";
import { subagentProfileSources } from "@/lib/subagent-profile-precedence";
import type { SubagentProfile } from "@/lib/subagents";
import {
  ConfigButton,
  ConfigPanelShell,
  ConfigSwitch,
  CountedTitle,
  SettingsBackLink,
  SettingsGroup,
  SettingsLinkRow,
  SettingsLoading,
  SettingsRow,
} from "./SettingsUi";
import { ReloadNotice } from "./ReloadNotice";
import { AgentsImportDialog } from "./AgentsImportDialog";
import { AgentDetail, AgentSaveFooter, profileTag, shortenPath, useAgentEditor } from "./AgentEditor";

export function AgentsConfig({
  cwd,
  sessionId = null,
  onClose,
  onReloaded,
  onChanged,
  embedded = false,
}: {
  cwd: string;
  sessionId?: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  /** Agent data or switches changed what the Project page shows. */
  onChanged?: () => void;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  // The last replies paint at once; the mount loads then revalidate them.
  const [seed] = useState(() => {
    const ok = <T,>(reply: JsonReply<T & { error?: string }> | undefined) => reply?.ok && !reply.data.error ? reply.data : undefined;
    const settings = ok(peekJson<Partial<SubagentSettingsResponse> & { error?: string }>(settingsUrls.subagentSettings(cwd)));
    return {
      profiles: ok(peekJson<Partial<SubagentProfilesResponse> & { error?: string }>(settingsUrls.subagentProfiles(cwd)))?.profiles,
      settings: typeof settings?.enabled === "boolean" ? settings : undefined,
    };
  });
  const [profiles, setProfiles] = useState<SubagentProfile[]>(seed.profiles ?? []);
  const [page, setPage] = useState<"list" | "detail">("list");
  const [loading, setLoading] = useState(!seed.profiles);
  const [builtInEnabled, setBuiltInEnabled] = useState(seed.settings?.enabled ?? true);
  const [project, setProject] = useState(seed.settings?.project ?? null);
  const [maxConcurrent, setMaxConcurrent] = useState(seed.settings?.maxConcurrent ?? 10);
  const [settingsLoading, setSettingsLoading] = useState(!seed.settings);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const fetchProfiles = useCallback(async () => {
    const response = await getJson<Partial<SubagentProfilesResponse> & { error?: string }>(settingsUrls.subagentProfiles(cwd));
    const data = response.data;
    if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
    const next = data.profiles ?? [];
    setProfiles(next);
    return next;
  }, [cwd]);

  const editor = useAgentEditor({
    cwd,
    profiles,
    refresh: fetchProfiles,
    onChanged: () => { setReloadNeeded(true); onChanged?.(); },
    onGone: () => setPage("list"),
  });
  const setEditorError = editor.setError;

  const rows = useMemo(() => [...new Set(profiles.map((profile) => profile.name.toLowerCase()))]
    .map((name) => {
      const sources = subagentProfileSources(profiles, name);
      const [top, below] = sources;
      const shownProfile = top.disableStub ? below ?? top : top;
      return { name, top, tag: profileTag(sources), label: shownProfile.displayName, description: shownProfile.description };
    })
    .sort((a, b) => a.label.localeCompare(b.label)), [profiles]);

  useEffect(() => {
    // The page opens on the list; only a save or restore re-selects the item it touched.
    setEditorError(null);
    fetchProfiles()
      .catch((cause) => setEditorError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, [fetchProfiles, setEditorError]);

  useEffect(() => {
    const controller = new AbortController();
    setSettingsError(null);
    void (async () => {
      try {
        const response = await getJson<Partial<SubagentSettingsResponse> & { error?: string }>(settingsUrls.subagentSettings(cwd));
        if (controller.signal.aborted) return;
        const data = response.data;
        if (!response.ok || data.error || typeof data.enabled !== "boolean") {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        setBuiltInEnabled(data.enabled);
        setProject(data.project ?? null);
        if (typeof data.maxConcurrent === "number") setMaxConcurrent(data.maxConcurrent);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setSettingsError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setSettingsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [cwd]);

  const putSubagentSwitch = async (change: { enabled: boolean } | { projectEnabled: boolean }) => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const response = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ...change }),
      });
      const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!response.ok || data.error || typeof data.enabled !== "boolean") {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setBuiltInEnabled(data.enabled);
      setProject(data.project ?? null);
      setReloadNeeded(true);
      onChanged?.();
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

  /** Sub-agents can run in this project at all: its own setting wins over the global default. */
  const activeHere = project?.enabled ?? builtInEnabled;

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.agents")} subtitle={shortenPath(cwd)} closeLabel={t("agents.close")} onClose={onClose}>
      {reloadNeeded && <ReloadNotice sessionId={sessionId} onReloaded={onReloaded} onDone={() => setReloadNeeded(false)} />}
      <div className="settings-scroll">
        <div key={loading ? "loading" : page} className="settings-page">
          {page === "list" ? (
            <>
              <SettingsGroup>
                <SettingsRow label={t("agents.builtInTitle")} description={t("agents.builtInDescription")}>
                  <ConfigSwitch
                    checked={builtInEnabled}
                    disabled={settingsLoading}
                    loading={settingsSaving}
                    label={t("agents.builtInTitle")}
                    onChange={(enabled) => void putSubagentSwitch({ enabled })}
                  />
                </SettingsRow>
                {project && (
                  <SettingsRow
                    label={t("agents.projectTitle")}
                    description={t("agents.projectDescription", { path: shortenPath(project.root) })}
                    title={project.root}
                  >
                    {project.overridden && <span className="settings-row-status">{t("project.tag.override")}</span>}
                    <ConfigSwitch
                      checked={project.enabled}
                      disabled={settingsLoading}
                      loading={settingsSaving}
                      label={t("agents.projectTitle")}
                      onChange={(projectEnabled) => void putSubagentSwitch({ projectEnabled })}
                    />
                  </SettingsRow>
                )}
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
                action={(
                  <span className="settings-group-actions">
                    <ConfigButton size="small" onClick={() => setImportOpen(true)}>{t("agents.import")}</ConfigButton>
                    <ConfigButton size="small" onClick={() => { editor.beginCreate(); setPage("detail"); }}>{t("agents.new")}</ConfigButton>
                  </span>
                )}
              >
                {!activeHere && <p role="status" className="settings-row-message">{t("agents.inactiveNotice")}</p>}
                {editor.error && <p role="alert" className="settings-row-message is-error">{editor.error}</p>}
                {loading ? (
                  <SettingsLoading label={t("agents.loading")} />
                ) : rows.map(({ name, top, tag, label, description }) => (
                  <SettingsLinkRow
                    key={name}
                    label={<>{label}{tag && <span className="settings-row-tag">{tag === "modified" ? t("agents.tag.modified") : t("agents.tag.project")}</span>}</>}
                    description={description}
                    muted={!top.enabled || !activeHere}
                    title={top.filePath}
                    onOpen={() => { editor.open(name); setPage("detail"); }}
                  >
                    <ConfigSwitch
                      checked={top.enabled}
                      disabled={editor.toggling || Boolean(top.configurationError)}
                      label={top.enabled ? t("agents.disable") : t("agents.enable")}
                      onChange={(value) => void editor.setEnabled(top.name, value)}
                    />
                  </SettingsLinkRow>
                ))}
              </SettingsGroup>
            </>
          ) : (
            <>
              <SettingsBackLink label={t("common.agents")} onClick={() => { setPage("list"); setEditorError(null); }} />
              <AgentDetail editor={editor} />
            </>
          )}
        </div>
      </div>
      {page === "detail" && <AgentSaveFooter editor={editor} />}
      {importOpen && (
        <AgentsImportDialog
          cwd={cwd}
          onClose={() => setImportOpen(false)}
          onImported={() => { void fetchProfiles(); setReloadNeeded(true); onChanged?.(); }}
        />
      )}
    </ConfigPanelShell>
  );
}
