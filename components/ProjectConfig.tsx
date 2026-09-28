"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ProjectOverridesWriteResponse,
  ProjectResourceGroup,
  ProjectResourceItem,
  ProjectResourcesResponse,
} from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import { getJson, peekJson, settingsUrls } from "@/lib/settings-cache";
import {
  ConfigButton,
  ConfigPanelShell,
  ConfigSwitch,
  CountedTitle,
  SettingsGroup,
  SettingsLinkRow,
  SettingsLoading,
  SettingsRow,
  SettingsSearch,
} from "./SettingsUi";
import { ReloadNotice } from "./ReloadNotice";

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

type Target = Pick<ProjectResourceItem, "type" | "path">;

/** A Pi Web feature with a global switch plus a per-project off switch (lib/project-feature-switch.ts). */
interface FeatureState {
  enabled: boolean;
  project?: { root: string; enabled: boolean };
}

/** Same settings as "Enable in this project" on the Agents and Images pages. */
const FEATURES = [
  { id: "subagents", label: "project.subagents", description: "project.subagentsDescription", globalOff: "agents.projectGlobalOff", putUrl: "/api/subagents/settings", url: settingsUrls.subagentSettings },
  { id: "images", label: "project.images", description: "project.imagesDescription", globalOff: "settings.imagesProjectGlobalOff", putUrl: "/api/image-generation/settings", url: settingsUrls.imageSettings },
] as const;
type FeatureId = (typeof FEATURES)[number]["id"];

/**
 * What the agent can use in this project: every global package and standalone
 * resource with one switch showing its effective state here. Flipping a switch
 * back to the global state drops the project override.
 */
export function ProjectConfig({ cwd, sessionId, onReloaded, onChanged }: {
  cwd: string;
  sessionId: string | null;
  onReloaded?: () => void;
  /** A project override or trust changed what the Plugins/Skills pages show. */
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const url = settingsUrls.projectResources(cwd);
  const [data, setData] = useState<ProjectResourcesResponse | null>(() => {
    const reply = peekJson<ProjectResourcesResponse & { error?: string }>(url);
    return reply?.ok && !reply.data.error ? reply.data : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [syncFailures, setSyncFailures] = useState<ProjectOverridesWriteResponse["failures"]>([]);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [features, setFeatures] = useState<Partial<Record<FeatureId, FeatureState>>>(() => Object.fromEntries(
    FEATURES.flatMap((feature) => {
      const reply = peekJson<FeatureState & { error?: string }>(feature.url(cwd));
      return reply?.ok && !reply.data.error ? [[feature.id, reply.data]] : [];
    }),
  ));

  const load = useCallback(async () => {
    try {
      const res = await getJson<ProjectResourcesResponse & { error?: string }>(url);
      if (!res.ok || res.data.error) throw new Error(res.data.error ?? `HTTP ${res.status}`);
      setData(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [url]);

  const loadFeatures = useCallback(async () => {
    const replies = await Promise.all(FEATURES.map(async (feature) => {
      const res = await getJson<FeatureState & { error?: string }>(feature.url(cwd));
      if (!res.ok || res.data.error) throw new Error(res.data.error ?? `HTTP ${res.status}`);
      return [feature.id, res.data] as const;
    }));
    setFeatures(Object.fromEntries(replies));
  }, [cwd]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    loadFeatures().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [loadFeatures]);

  // Every change is saved immediately; an open session picks it up only after a reload.
  const run = useCallback(async (action: () => Promise<void>, needsReload: boolean) => {
    setBusy(true);
    setError(null);
    setSyncFailures([]);
    try {
      await action();
      await Promise.all([load(), loadFeatures()]);
      setReloadNeeded(needsReload);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [load, loadFeatures, onChanged]);

  const post = async (targets: Target[], enabled: boolean) => {
    const res = await fetch("/api/project-overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, enabled, targets: targets.map(({ type, path }) => ({ type, path })) }),
    });
    const body = (await res.json()) as Partial<ProjectOverridesWriteResponse> & { error?: string };
    if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
    if (body.failures?.length) setSyncFailures((current) => [...current, ...body.failures!]);
  };

  const setEnabled = (targets: Target[], enabled: boolean) => run(() => post(targets, enabled), true);

  const putFeatureEnabled = async (putUrl: string, projectEnabled: boolean) => {
    const res = await fetch(putUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, projectEnabled }),
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  };
  const featuresOff = FEATURES.filter((feature) => features[feature.id]?.project?.enabled === false);

  const groups = data?.groups ?? [];
  const overridden = groups.flatMap((group) => group.items.filter((item) => item.overridden));
  const itemCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const enabledCount = groups.reduce((sum, group) => sum + group.items.filter((item) => item.enabled).length, 0);
  // Everything this project does differently from global: resource overrides plus the sub-agent switch.
  const differences = overridden.length + featuresOff.length;
  const resetAll = () => run(async () => {
    const back = (item: ProjectResourceItem) => item.globalEnabled ?? true;
    const on = overridden.filter(back);
    const off = overridden.filter((item) => !back(item));
    if (on.length) await post(on, true);
    if (off.length) await post(off, false);
    for (const feature of featuresOff) await putFeatureEnabled(feature.putUrl, true);
  }, true);

  // Same endpoint as the trust dialog; it also drops runtimes built without project resources.
  const trust = () => run(async () => {
    const res = await fetch("/api/project-trust", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  }, false);

  const needle = filter.trim().toLowerCase();
  const matches = (group: ProjectResourceGroup, item: ProjectResourceItem) =>
    !needle || `${group.label} ${item.name}`.toLowerCase().includes(needle);
  const visible = groups.filter((group) => group.items.some((item) => matches(group, item)));
  // Sorted, so a row does not jump when an override adds or drops its project entry.
  // Package switches and counts always cover the whole package; search only picks rows.
  const packages = visible
    .filter((group) => group.origin === "package")
    .sort((a, b) => a.label.localeCompare(b.label));
  const standalone = visible.filter((group) => group.origin === "top-level");
  const trusted = data?.projectResourcesLoaded ?? true;
  const locked = busy || !trusted;
  const resetLocked = busy || (!trusted && overridden.length > 0);
  const projectName = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  const sync = data?.sync;
  const syncHint = !sync ? null
    : sync.kind === "worktrees" ? (sync.otherWorktrees > 0 ? t("project.sync.worktrees", { count: sync.otherWorktrees }) : null)
      : sync.kind === "tracked" ? t("project.sync.tracked")
        : sync.kind === "subdirectory" ? t("project.sync.subdirectory")
          : null;

  const typeLabel = (item: ProjectResourceItem) => t(`project.type.${item.type}`);
  const itemState = (item: ProjectResourceItem) => !item.editable
    ? t("project.handWritten")
    : item.globalEnabled === null
    ? t("project.projectOnly")
    : item.overridden
      ? item.globalEnabled ? t("project.globalOn") : t("project.globalOff")
      : null;

  const itemRow = (item: ProjectResourceItem, nested: boolean) => {
    const state = itemState(item);
    return (
      <div key={`${item.type}:${item.path}`} className={`settings-row${nested ? " is-nested" : ""}`} title={item.path}>
        <div className="settings-row-copy">
          <span className={`settings-row-label${item.enabled ? "" : " is-dim"}`}>{item.name}</span>
          <span className="settings-row-description">{typeLabel(item)}{state && <> · {state}</>}</span>
        </div>
        <div className="settings-row-control">
          {item.overridden && <span className="settings-row-status">{t("project.tag.override")}</span>}
          <ConfigSwitch
            checked={item.enabled}
            disabled={locked || !item.editable}
            label={item.name}
            onChange={(enabled) => void setEnabled([item], enabled)}
          />
        </div>
      </div>
    );
  };

  return (
    <ConfigPanelShell embedded title={t("project.title")} subtitle={shortenPath(cwd)} closeLabel={t("i18n.close")} onClose={() => {}}>
      {reloadNeeded && <ReloadNotice sessionId={sessionId} onReloaded={onReloaded} onDone={() => setReloadNeeded(false)} />}
      <div className="settings-scroll">
        <div className="settings-page">
          <div className="settings-sticky-head">
            <div className="project-head" title={`${cwd}/.pi/settings.json`}>
              <span className="project-head-name">{projectName}</span>
              <span className="project-head-path">
                {shortenPath(cwd)}
                {syncHint && <> · {syncHint}</>}
              </span>
            </div>
            <div className="settings-toolbar">
              <SettingsSearch value={filter} onChange={setFilter} placeholder={t("project.filterPlaceholder")} />
              <span className="settings-toolbar-spacer" />
              {data && <span className="settings-toolbar-summary">{t("project.summary", { loaded: enabledCount, total: itemCount })}</span>}
            </div>
            {differences > 0 && (
              <p role="status" className="settings-row-message project-differences">
                <span>{t("project.differences", { count: differences })}</span>
                <ConfigButton size="small" onClick={() => void resetAll()} disabled={resetLocked}>{t("project.resetAll")}</ConfigButton>
              </p>
            )}
            {!trusted && (
              <p role="status" className="settings-row-message is-warning">
                {t("project.untrusted")}{" "}
                <ConfigButton size="small" onClick={() => void trust()} disabled={busy}>{t("trust.trustProject")}</ConfigButton>
              </p>
            )}
            {syncFailures.length > 0 && (
              <p role="alert" className="settings-row-message is-warning is-pre">
                {t("project.sync.failed")}
                {syncFailures.map((failure) => `\n${shortenPath(failure.path)}: ${failure.error}`).join("")}
              </p>
            )}
            {error && <p role="alert" className="settings-row-message is-error is-pre">{error}</p>}
          </div>
          {!data ? (
            error ? null : <SettingsLoading label={t("i18n.loading")} />
          ) : (
            <>
              {FEATURES.some((feature) => features[feature.id]?.project) && (
                <SettingsGroup>
                  {FEATURES.map((feature) => {
                    const state = features[feature.id];
                    if (!state?.project) return null;
                    const off = !state.project.enabled;
                    return (
                      <SettingsRow key={feature.id} label={t(feature.label)} description={state.enabled ? t(feature.description) : t(feature.globalOff)}>
                        {off && state.enabled && <span className="settings-row-status">{t("project.tag.override")}</span>}
                        <ConfigSwitch
                          checked={state.enabled && state.project.enabled}
                          disabled={busy || !state.enabled}
                          label={t(feature.label)}
                          onChange={(enabled) => void run(() => putFeatureEnabled(feature.putUrl, enabled), true)}
                        />
                      </SettingsRow>
                    );
                  })}
                </SettingsGroup>
              )}
              {packages.length > 0 && (
                <SettingsGroup title={<CountedTitle label={t("project.group.packages")} count={packages.length} />}>
                  {packages.flatMap((group) => {
                    const loaded = group.items.filter((item) => item.enabled).length;
                    const editable = group.items.every((item) => item.editable);
                    const open = Boolean(needle) || expanded.has(group.key);
                    const toggleOpen = () => setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(group.key)) next.delete(group.key);
                      else next.add(group.key);
                      return next;
                    });
                    return [
                      <SettingsLinkRow
                        key={group.key}
                        label={(
                          <span className="settings-disclosure-label">
                            <svg className="settings-disclosure" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d={open ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6"} />
                            </svg>
                            {group.label}
                          </span>
                        )}
                        description={<>{shortenPath(group.source)} · {t("project.loadedCount", { loaded, total: group.items.length })}{!editable && <> · {t("project.handWritten")}</>}</>}
                        muted={loaded === 0}
                        title={group.source}
                        onOpen={toggleOpen}
                      >
                        {group.items.some((item) => item.overridden) && (
                          <span className="settings-row-status">{t("project.tag.override")}</span>
                        )}
                        <ConfigSwitch
                          checked={loaded > 0}
                          disabled={locked || !editable}
                          label={group.label}
                          onChange={(enabled) => void setEnabled(group.items, enabled)}
                        />
                      </SettingsLinkRow>,
                      ...(open ? group.items.filter((item) => matches(group, item)).map((item) => itemRow(item, true)) : []),
                    ];
                  })}
                </SettingsGroup>
              )}
              {standalone.map((group) => (
                <SettingsGroup
                  key={group.key}
                  title={<CountedTitle label={t(group.scope === "project" ? "project.group.projectLocal" : "project.group.standalone")} count={group.items.filter((item) => matches(group, item)).length} />}
                >
                  {group.items.filter((item) => matches(group, item)).map((item) => itemRow(item, false))}
                </SettingsGroup>
              ))}
              {visible.length === 0 && <p className="settings-row-message">{t("skills.noResults")}</p>}
            </>
          )}
        </div>
      </div>
    </ConfigPanelShell>
  );
}
