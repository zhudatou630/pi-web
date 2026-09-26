"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import type { PluginPackageInfo, PluginStandaloneExtensionInfo, PluginUpdateResult, PluginsResponse } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import { getJson, peekJson, settingsUrls } from "@/lib/settings-cache";
import {
  ConfigButton,
  ConfigPanelShell,
  ConfigStatusDot,
  ConfigSwitch,
  CountedTitle,
  SettingsBackLink,
  SettingsDetailPage,
  SettingsGroup,
  SettingsLinkRow,
  SettingsLoading,
  SettingsProperties,
  SettingsProperty,
  SettingsRow,
  SettingsSegmented,
} from "./SettingsUi";

type PluginScope = PluginPackageInfo["scope"];
type PluginAction = "install" | "remove" | "update" | "disable" | "enable";

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function normalizePluginSourceInput(value: string): string {
  const match = value.trim().match(/^\$?\s*pi\s+install\s+(\S+)\s*$/);
  return match?.[1] ?? value;
}

function packageKey(pkg: Pick<PluginPackageInfo, "source" | "scope">): string {
  return `${pkg.scope}\0${pkg.source}`;
}

function extensionKey(extension: PluginStandaloneExtensionInfo): string {
  return `extension\0${extension.path}`;
}

function resourceSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  if (pkg.disabled) return t("i18n.disabled");
  const parts = [
    pkg.counts.extensions ? t("i18n.resourceCount", { count: pkg.counts.extensions, label: t(pkg.counts.extensions === 1 ? "i18n.extensionShortOne" : "i18n.extensionShort") }) : "",
    pkg.counts.skills ? t("i18n.resourceCount", { count: pkg.counts.skills, label: t(pkg.counts.skills === 1 ? "i18n.skillShortOne" : "i18n.skillShort") }) : "",
    pkg.counts.prompts ? t("i18n.resourceCount", { count: pkg.counts.prompts, label: t(pkg.counts.prompts === 1 ? "i18n.promptShortOne" : "i18n.promptShort") }) : "",
    pkg.counts.themes ? t("i18n.resourceCount", { count: pkg.counts.themes, label: t(pkg.counts.themes === 1 ? "i18n.themeShortOne" : "i18n.themeShort") }) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("i18n.noResources");
}

function versionSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  const parts = [];
  if (pkg.version) parts.push(t("i18n.installedVersion", { version: pkg.version }));
  if (pkg.configuredVersion) parts.push(t("i18n.configuredVersion", { version: pkg.configuredVersion }));
  return parts.length ? parts.join(" · ") : t("i18n.unknown");
}

function installLocation(scope: PluginScope, cwd: string): string {
  return scope === "project"
    ? `${shortenPath(cwd)}/.pi/agent/{npm,git}`
    : "~/.pi/agent/{npm,git}";
}

function findInstalledPackage(
  packages: PluginPackageInfo[],
  source: string,
  scope: PluginScope,
): PluginPackageInfo | undefined {
  const trimmed = source.trim();
  const withoutNpmPrefix = trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
  return packages.find((pkg) => pkg.scope === scope && pkg.source === trimmed)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.source === `npm:${withoutNpmPrefix}`)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.source.endsWith(trimmed));
}

function ResourceList({ pkg }: { pkg: PluginPackageInfo }) {
  const { t } = useI18n();
  const groups = ([
    ["extension", t("i18n.extensions")],
    ["skill", t("i18n.skills")],
    ["prompt", t("i18n.prompts")],
    ["theme", t("i18n.themes")],
  ] as const)
    .map(([kind, label]) => ({
      kind,
      label,
      resources: pkg.resources.filter((resource) => resource.kind === kind),
    }))
    .filter((group) => group.resources.length > 0);

  if (groups.length === 0) {
    return (
      <SettingsGroup title={t("i18n.resolvedResources")}>
        <p className="settings-row-message">
          {pkg.disabled ? t("i18n.packageDisabled") : t("i18n.noResolvedResources")}
        </p>
      </SettingsGroup>
    );
  }

  return groups.map((group) => (
    <SettingsGroup key={group.kind} title={`${group.label} · ${group.resources.length}`}>
      {group.resources.map((resource) => (
        <SettingsRow
          key={`${resource.kind}:${resource.path}`}
          title={resource.path}
          label={resource.name}
          description={resource.relativePath}
        />
      ))}
    </SettingsGroup>
  ));
}

function ScopeTag({ scope }: { scope: PluginScope }) {
  return <span className={`config-scope-tag${scope === "project" ? " is-project" : ""}`}>{scope}</span>;
}

function AddPluginPanel({
  cwd,
  source,
  scope,
  projectResourcesLoaded,
  busy,
  actionError,
  onSourceChange,
  onScopeChange,
  onInstall,
}: {
  cwd: string;
  source: string;
  scope: PluginScope;
  projectResourcesLoaded: boolean;
  busy: boolean;
  actionError: string | null;
  onSourceChange: (value: string) => void;
  onScopeChange: (scope: PluginScope) => void;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const examples = ["npm:@scope/pi-plugin", "git:https://github.com/user/repo", "/absolute/path/to/plugin"];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <SettingsDetailPage
      title={t("i18n.addPlugin")}
      description={(
        <>
          {t("plugins.addDescription")}{" "}
          <a href="https://pi.dev/packages" target="_blank" rel="noopener noreferrer" className="settings-link">pi.dev/packages ↗</a>
        </>
      )}
    >
      <SettingsGroup>
        <div className="settings-search">
          <input
            id="plugin-source"
            ref={inputRef}
            className="settings-search-input is-mono"
            aria-label={t("plugins.source")}
            value={source}
            onChange={(e) => onSourceChange(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData("text");
              const normalized = normalizePluginSourceInput(pasted);
              if (normalized === pasted) return;
              e.preventDefault();
              onSourceChange(normalized);
            }}
            onBlur={(e) => onSourceChange(normalizePluginSourceInput(e.currentTarget.value))}
            placeholder="npm:@scope/package"
            onKeyDown={(e) => {
              if (e.key === "Enter" && source.trim() && !busy) onInstall();
            }}
          />
          <ConfigButton variant="primary" onClick={onInstall} disabled={busy || !source.trim()}>
            {busy ? t("i18n.installing") : t("i18n.install")}
          </ConfigButton>
        </div>
        <SettingsRow label={t("skills.installTo")} description={installLocation(scope, cwd)}>
          <SettingsSegmented
            label={t("skills.installTo")}
            value={scope}
            onChange={onScopeChange}
            options={[
              { value: "global", label: t("skills.scope.global") },
              {
                value: "project",
                label: t("skills.scope.project"),
                disabled: !projectResourcesLoaded,
                title: projectResourcesLoaded ? undefined : t("trust.projectScopeUnavailable"),
              },
            ]}
          />
        </SettingsRow>
        {actionError && <p role="alert" className="settings-row-message is-error is-pre">{actionError}</p>}
      </SettingsGroup>

      <SettingsGroup title={t("plugins.examples")}>
        <div className="settings-examples">
          {examples.map((example) => (
            <button key={example} type="button" className="settings-example" onClick={() => onSourceChange(example)}>
              {example}
            </button>
          ))}
        </div>
      </SettingsGroup>
    </SettingsDetailPage>
  );
}

function PackageDetail({
  pkg,
  busyKey,
  actionError,
  actionMessage,
  sessionId,
  updateStatus,
  checkingUpdate,
  updateError,
  onAction,
  onCheckUpdate,
  onReloadSession,
}: {
  pkg: PluginPackageInfo;
  busyKey: string | null;
  actionError: string | null;
  actionMessage: string | null;
  sessionId: string | null;
  updateStatus?: PluginUpdateResult;
  checkingUpdate: boolean;
  updateError: string | null;
  onAction: (action: PluginAction, pkg: PluginPackageInfo) => void;
  onCheckUpdate: () => void;
  onReloadSession: () => void;
}) {
  const { t } = useI18n();
  const key = packageKey(pkg);
  const busy = busyKey?.endsWith(key) ?? false;
  const reloadBusy = busyKey === "reload";
  const enabled = !pkg.disabled;
  const canCheckForUpdates = pkg.canCheckForUpdates;
  const updateAvailable = updateStatus?.state === "update-available";
  const statusText = canCheckForUpdates && (checkingUpdate || (updateStatus && !updateAvailable))
    ? checkingUpdate
      ? t("i18n.checking")
      : updateStatus?.state === "up-to-date"
        ? t("i18n.upToDate")
        : updateStatus?.state === "unsupported"
          ? t("i18n.automaticChecksUnavailable")
          : updateStatus?.message || t("i18n.checkFailed")
    : null;

  return (
    <SettingsDetailPage
      title={pkg.packageName ?? pkg.source}
      meta={(
        <>
          <ScopeTag scope={pkg.scope} />
          {pkg.disabled ? (
            <span className="config-scope-tag">{t("i18n.disabled")}</span>
          ) : pkg.filtered && (
            <span className="config-scope-tag is-warning">{t("i18n.filtered")}</span>
          )}
          <span className="config-detail-path" title={pkg.source}>{pkg.source}</span>
        </>
      )}
    >
      <SettingsGroup>
        <SettingsRow label={t("plugins.enabled")} description={t("plugins.enabledDescription")}>
          <ConfigSwitch
            checked={enabled}
            loading={busy || reloadBusy}
            onChange={() => onAction(pkg.disabled ? "enable" : "disable", pkg)}
            label={pkg.disabled ? t("i18n.enablePackage") : t("i18n.disablePackage")}
          />
        </SettingsRow>
        <SettingsRow
          label={t("i18n.version")}
          description={(
            <>
              <span>{versionSummary(pkg, t)}</span>
              {updateAvailable && <> · <span className="is-accent" title={updateStatus.displayName}>{t("i18n.updateAvailable")}</span></>}
              {statusText && <> · <span className={updateStatus?.state === "error" ? "is-error" : undefined}>{statusText}</span></>}
            </>
          )}
        >
          <ConfigButton
            size="small"
            variant={updateAvailable ? "primary" : undefined}
            onClick={updateAvailable || !canCheckForUpdates
              ? () => onAction("update", pkg)
              : onCheckUpdate}
            disabled={busy || reloadBusy || checkingUpdate}
          >
            {busyKey === `update:${key}`
              ? t("i18n.updating")
              : checkingUpdate
                ? t("i18n.checking")
                : updateAvailable || !canCheckForUpdates
                  ? t("i18n.update")
                  : t("i18n.check")}
          </ConfigButton>
        </SettingsRow>
        {updateError && <p role="alert" className="settings-row-message is-error">{updateError}</p>}
        <SettingsRow
          label={t("i18n.reloadSession")}
          description={sessionId ? t("plugins.reloadDescription") : t("i18n.openSessionToReload")}
        >
          <ConfigButton size="small" onClick={onReloadSession} disabled={!sessionId || reloadBusy || busy}>
            {reloadBusy ? t("i18n.reloading") : t("plugins.reload")}
          </ConfigButton>
        </SettingsRow>
        {actionMessage && <p role="status" className="settings-row-message is-success">{actionMessage}</p>}
        {actionError && <p role="alert" className="settings-row-message is-error">{actionError}</p>}
      </SettingsGroup>

      <SettingsGroup title={t("settings.details")}>
        <SettingsProperties>
          <SettingsProperty label={t("i18n.status")}>
            <span className={`settings-status is-${pkg.status}`}>{pkg.status}</span>
          </SettingsProperty>
          <SettingsProperty label={t("i18n.resources")}>{resourceSummary(pkg, t)}</SettingsProperty>
          <SettingsProperty label={t("i18n.installedPath")}>
            {pkg.installedPath ? shortenPath(pkg.installedPath) : <span className="is-error">{t("i18n.notFound")}</span>}
          </SettingsProperty>
        </SettingsProperties>
      </SettingsGroup>

      <ResourceList pkg={pkg} />

      <SettingsGroup>
        <SettingsRow label={t("plugins.removeTitle")} description={t("plugins.removeDescription")}>
          <ConfigButton variant="danger" size="small" onClick={() => onAction("remove", pkg)} disabled={busy || reloadBusy}>
            {busyKey === `remove:${key}` ? t("i18n.removing") : t("i18n.remove")}
          </ConfigButton>
        </SettingsRow>
      </SettingsGroup>
    </SettingsDetailPage>
  );
}

function StandaloneExtensionDetail({ extension }: { extension: PluginStandaloneExtensionInfo }) {
  const { t } = useI18n();
  const status = extension.enabled ? "loaded" : "disabled";

  return (
    <SettingsDetailPage
      title={extension.name}
      meta={(
        <>
          <ScopeTag scope={extension.scope} />
          <span className="config-detail-path" title={extension.path}>{shortenPath(extension.path)}</span>
        </>
      )}
    >
      <SettingsGroup title={t("settings.details")}>
        <SettingsProperties>
          <SettingsProperty label={t("i18n.status")}>
            <span className={`settings-status is-${status}`}>{status}</span>
          </SettingsProperty>
          <SettingsProperty label={t("i18n.installedPath")}>{shortenPath(extension.path)}</SettingsProperty>
        </SettingsProperties>
      </SettingsGroup>
    </SettingsDetailPage>
  );
}

export function PluginsConfig({
  cwd,
  sessionId,
  onClose,
  onReloaded,
  embedded = false,
}: {
  cwd: string;
  sessionId: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  // The last reply paints at once; the mount load then revalidates it.
  const [data, setData] = useState<PluginsResponse | null>(() => {
    const reply = peekJson<PluginsResponse & { error?: string }>(settingsUrls.plugins(cwd));
    return reply?.ok && !reply.data.error ? reply.data : null;
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "detail" | "add">("list");
  const [installSource, setInstallSource] = useState("");
  const [installScope, setInstallScope] = useState<PluginScope>("global");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, PluginUpdateResult>>({});
  const [checkingUpdates, setCheckingUpdates] = useState<Set<string>>(new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);

  const packages = useMemo(() => data?.packages ?? [], [data?.packages]);
  const standaloneExtensions = useMemo(() => data?.standaloneExtensions ?? [], [data?.standaloneExtensions]);
  const selectedPackage = packages.find((pkg) => packageKey(pkg) === selected) ?? null;
  const selectedExtension = standaloneExtensions.find((extension) => extensionKey(extension) === selected) ?? null;
  const projectResourcesLoaded = data?.projectResourcesLoaded ?? true;

  const groupedPackages = useMemo(() => {
    return (["project", "global"] as PluginScope[])
      .map((scope) => ({ scope, packages: packages.filter((pkg) => pkg.scope === scope) }))
      .filter((group) => group.packages.length > 0);
  }, [packages]);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getJson<PluginsResponse & { error?: string }>(settingsUrls.plugins(cwd));
      const next = res.data;
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    setUpdateStatuses({});
    setUpdateError(null);
    void loadPlugins();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkForUpdates = useCallback(async (pkg?: PluginPackageInfo) => {
    const targets = pkg ? [pkg] : packages.filter((item) => item.canCheckForUpdates);
    const keys = targets.map(packageKey);
    if (keys.length === 0) return;

    setUpdateError(null);
    setCheckingUpdates((current) => new Set([...current, ...keys]));
    if (!pkg) setCheckingAll(true);
    try {
      const res = await fetch("/api/plugins/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          source: pkg?.source,
          scope: pkg?.scope,
        }),
      });
      const data = (await res.json()) as {
        updates?: PluginUpdateResult[];
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUpdateStatuses((current) => {
        const next = { ...current };
        for (const update of data.updates ?? []) {
          next[packageKey(update)] = update;
        }
        return next;
      });
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingUpdates((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
      if (!pkg) setCheckingAll(false);
    }
  }, [cwd, packages]);

  const updateAllPluginsAction = useCallback(async () => {
    setUpdatingAll(true);
    setActionError(null);
    setActionMessage(null);
    setUpdateError(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", cwd }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setUpdateStatuses({});
      setActionMessage(t("i18n.packagesUpdated"));
      if (sessionId) {
        setActionMessage(`${t("i18n.packagesUpdated")} ${t("agents.reloadRequired")}`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdatingAll(false);
    }
  }, [cwd, sessionId, t]);

  const runAction = useCallback(async (action: PluginAction, pkg: PluginPackageInfo) => {
    const key = packageKey(pkg);
    setBusyKey(`${action}:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, source: pkg.source, scope: pkg.scope, cwd }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      if (action === "remove") {
        setSelected(null);
        setView("list");
        setActionMessage("Package removed.");
        setUpdateStatuses((current) => {
          const nextStatuses = { ...current };
          delete nextStatuses[key];
          return nextStatuses;
        });
      } else {
        const messages: Record<Exclude<PluginAction, "remove">, string> = {
          install: "Package installed.",
          update: "Package updated.",
          disable: "Package disabled.",
          enable: "Package enabled.",
        };
        setActionMessage(messages[action]);
        if (action === "update") {
          setUpdateStatuses((current) => {
            const nextStatuses = { ...current };
            delete nextStatuses[key];
            return nextStatuses;
          });
        }
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [cwd]);

  const installPlugin = useCallback(async () => {
    const source = normalizePluginSourceInput(installSource).trim();
    if (!source) return;
    setInstallSource(source);
    const key = `${installScope}\0${source}`;
    setBusyKey(`install:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install", source, scope: installScope, cwd }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      const installed = findInstalledPackage(next.packages, source, installScope);
      setSelected(installed ? packageKey(installed) : key);
      setView("detail");
      setInstallSource("");
      setActionMessage("Package installed.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [cwd, installScope, installSource]);

  const reloadSession = useCallback(async () => {
    if (!sessionId) return;
    setBusyKey("reload");
    setActionError(null);
    setActionMessage(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      onReloaded?.();
      await loadPlugins();
      setActionMessage("Session reloaded.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [loadPlugins, onReloaded, sessionId]);

  const addBusy = busyKey?.startsWith("install:") ?? false;
  const availableUpdateCount = Object.values(updateStatuses).filter(
    (status) => status.state === "update-available",
  ).length;
  const hasCheckablePackages = packages.some((pkg) => pkg.canCheckForUpdates);
  const toolbarBusy = loading || busyKey !== null || checkingUpdates.size > 0 || updatingAll;
  const openList = () => { setView("list"); setActionError(null); setActionMessage(null); };
  const openItem = (key: string) => { setSelected(key); setActionError(null); setActionMessage(null); setView("detail"); };

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.plugins")} subtitle={shortenPath(cwd)} closeLabel={t("i18n.close")} onClose={onClose}>
      <div className="settings-scroll">
        <div key={loading && !data ? "loading" : view} className="settings-page">
          {view === "add" ? (
            <>
              <SettingsBackLink label={t("common.plugins")} onClick={openList} />
              <AddPluginPanel
                cwd={cwd}
                source={installSource}
                scope={installScope}
                projectResourcesLoaded={projectResourcesLoaded}
                busy={addBusy}
                actionError={actionError}
                onSourceChange={setInstallSource}
                onScopeChange={setInstallScope}
                onInstall={installPlugin}
              />
            </>
          ) : view === "detail" && (selectedExtension || selectedPackage) ? (
            <>
              <SettingsBackLink label={t("common.plugins")} onClick={openList} />
              {selectedExtension ? (
                <StandaloneExtensionDetail extension={selectedExtension} />
              ) : selectedPackage && (
                <PackageDetail
                  key={packageKey(selectedPackage)}
                  pkg={selectedPackage}
                  busyKey={busyKey}
                  actionError={actionError}
                  actionMessage={actionMessage}
                  sessionId={sessionId}
                  updateStatus={updateStatuses[packageKey(selectedPackage)]}
                  checkingUpdate={checkingUpdates.has(packageKey(selectedPackage))}
                  updateError={updateError}
                  onAction={runAction}
                  onCheckUpdate={() => void checkForUpdates(selectedPackage)}
                  onReloadSession={reloadSession}
                />
              )}
            </>
          ) : (
            <>
              {!projectResourcesLoaded && <p role="status" className="settings-row-message is-warning">{t("trust.pluginsNotLoaded")}</p>}
              <div className="settings-toolbar">
                {data && (
                  <span className="settings-toolbar-summary">
                    {t("plugins.summary", { count: packages.length, enabled: packages.filter((pkg) => !pkg.disabled).length })}
                  </span>
                )}
                <span className="settings-toolbar-spacer" />
                <ConfigButton size="small" variant="ghost" onClick={() => void loadPlugins()} disabled={toolbarBusy}>
                  {t("i18n.refresh")}
                </ConfigButton>
                {hasCheckablePackages && (
                  <ConfigButton
                    size="small"
                    variant={availableUpdateCount > 0 ? "primary" : "ghost"}
                    onClick={() => void (availableUpdateCount > 0 ? updateAllPluginsAction() : checkForUpdates())}
                    disabled={toolbarBusy}
                    title={availableUpdateCount > 0 ? t("i18n.updateAllPluginsHint") : undefined}
                  >
                    {updatingAll
                      ? t("i18n.updating")
                      : checkingAll
                        ? t("i18n.checking")
                        : availableUpdateCount > 0
                          ? `${t("i18n.updateAllPlugins")} · ${availableUpdateCount}`
                          : t("i18n.checkUpdates")}
                  </ConfigButton>
                )}
                <ConfigButton size="small" onClick={() => { setActionError(null); setView("add"); }}>{t("i18n.addPlugin")}</ConfigButton>
              </div>
              {data?.diagnostics.length ? (
                <p
                  className={`settings-row-message ${data.diagnostics.some((d) => d.type === "error") ? "is-error" : "is-warning"}`}
                  title={data.diagnostics.map((d) => `${d.type}: ${d.source ? `${d.source}: ` : ""}${d.message}`).join("\n")}
                >
                  {t("plugins.diagnostics", { count: data.diagnostics.length })}
                </p>
              ) : null}
              {actionMessage && <p role="status" className="settings-row-message is-success">{actionMessage}</p>}
              {(actionError || updateError) && <p role="alert" className="settings-row-message is-error is-pre">{actionError || updateError}</p>}
              {loading && !data ? (
                <SettingsLoading label={t("i18n.loading")} />
              ) : error ? (
                <p role="alert" className="settings-row-message is-error">{error}</p>
              ) : packages.length === 0 && standaloneExtensions.length === 0 ? (
                <p className="settings-row-message">{t("plugins.empty")}</p>
              ) : (
                <>
                  {groupedPackages.map((group) => (
                    <SettingsGroup key={group.scope} title={<CountedTitle label={t(`skills.group.${group.scope}`)} count={group.packages.length} />}>
                      {group.packages.map((pkg) => {
                        const key = packageKey(pkg);
                        const busy = busyKey?.endsWith(key) ?? false;
                        return (
                          <SettingsLinkRow
                            key={key}
                            label={pkg.packageName ?? pkg.source}
                            description={<>{shortenPath(pkg.source)}{" · "}{resourceSummary(pkg, t)}</>}
                            muted={pkg.disabled}
                            title={pkg.source}
                            onOpen={() => openItem(key)}
                          >
                            {(pkg.status === "installed" || pkg.status === "missing") && (
                              <ConfigStatusDot tone={pkg.status === "missing" ? "danger" : "warning"} title={pkg.status} />
                            )}
                            {updateStatuses[key]?.state === "update-available" && (
                              <span className="settings-row-status is-accent">{t("i18n.updateAvailable")}</span>
                            )}
                            <ConfigSwitch
                              checked={!pkg.disabled}
                              loading={busy}
                              disabled={busyKey === "reload"}
                              label={pkg.disabled ? t("i18n.enablePackage") : t("i18n.disablePackage")}
                              onChange={() => void runAction(pkg.disabled ? "enable" : "disable", pkg)}
                            />
                          </SettingsLinkRow>
                        );
                      })}
                    </SettingsGroup>
                  ))}
                  {standaloneExtensions.length > 0 && (
                    <SettingsGroup title={<CountedTitle label={t("i18n.extensions")} count={standaloneExtensions.length} />}>
                      {standaloneExtensions.map((extension) => (
                        <SettingsLinkRow
                          key={extensionKey(extension)}
                          label={extension.name}
                          description={shortenPath(extension.path)}
                          muted={!extension.enabled}
                          title={extension.path}
                          onOpen={() => openItem(extensionKey(extension))}
                        />
                      ))}
                    </SettingsGroup>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </ConfigPanelShell>
  );
}
