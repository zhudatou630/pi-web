"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { McpCheckResponse, McpServerView, McpSettingsResponse } from "@/lib/api-types";
import { parseMcpDraft } from "@/lib/mcp-draft";
import { getJson, peekJson, settingsUrls } from "@/lib/settings-cache";
import { ReloadNotice } from "./ReloadNotice";
import { Select } from "./Select";
import { ConfigButton, ConfigField, ConfigSwitch, CountedTitle, SettingsGroup, SettingsLoading, SettingsRow, SettingsSegmented } from "./SettingsUi";

const EXPOSURES = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"] as const;

type Scope = McpServerView["scope"];
type Draft = { name: string; scope: Scope; json: string; previous?: { name: string; scope: Scope } };
type CheckReport = McpCheckResponse["servers"][number];

const serverKey = (server: { name: string; scope: Scope }) => `${server.scope}:${server.name}`;

export function McpConfig({ cwd = null, sessionId = null, onReloaded, onChanged }: {
  cwd?: string | null;
  sessionId?: string | null;
  onReloaded?: () => void;
  /** Built-in switches changed what the Project page shows. */
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const url = settingsUrls.mcp(cwd);
  const [settings, setSettings] = useState<McpSettingsResponse | null>(() => {
    const reply = peekJson<McpSettingsResponse & { error?: string }>(url);
    return reply?.ok && !reply.data.error ? reply.data : null;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<McpCheckResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getJson<McpSettingsResponse & { error?: string }>(url)
      .then((response) => {
        if (!response.ok || response.data.error) throw new Error(response.data.error ?? `HTTP ${response.status}`);
        if (!cancelled) setSettings(response.data);
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [url]);

  const request = async (method: "PUT" | "PATCH" | "DELETE", body: Record<string, unknown>) => {
    const response = await fetch("/api/mcp", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, ...(cwd ? { cwd } : {}) }),
    });
    const data = await response.json() as McpSettingsResponse & { error?: string };
    if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
    setSettings(data);
    setReloadNeeded(true);
    setCheck(null);
  };

  const run = async (action: () => Promise<void>) => {
    setSaving(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = (current: Draft) => run(async () => {
    const entries = parseMcpDraft(current.name, current.json);
    for (const [name, config] of entries) {
      await request("PUT", {
        scope: current.scope,
        name,
        config,
        ...(current.previous && current.previous.scope === current.scope ? { previousName: current.previous.name } : {}),
      });
    }
    // Moving a server to the other file removes it from the first one.
    if (current.previous && current.previous.scope !== current.scope) {
      await request("DELETE", { scope: current.previous.scope, name: current.previous.name });
    }
    setDraft(null);
  });

  const runCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      const response = await fetch("/api/mcp/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cwd ? { cwd } : {}),
      });
      const data = await response.json() as McpCheckResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setCheck(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  };

  if (!settings) {
    return <div className="settings-page">{error ? <p role="alert" className="settings-row-message is-error">{error}</p> : <SettingsLoading label={t("i18n.loading")} />}</div>;
  }

  const mcpBuiltin = settings.builtins.find((builtin) => builtin.name === "mcp");
  const projectAvailable = settings.project !== null;
  const reports = new Map((check?.servers ?? []).map((report) => [serverKey(report), report]));
  const describe = (server: McpServerView) => {
    const lines = [server.transport];
    if (/\/sse\/?(\?|$)/.test(server.transport)) lines.push(t("mcp.sseHint"));
    if (server.overridden) lines.push(t("mcp.overridden"));
    const report = reports.get(serverKey(server));
    if (report) lines.push(reportText(report));
    return lines.join("\n");
  };
  const reportText = (report: CheckReport) => {
    if (report.state === "connected") return t("mcp.connected", { count: report.tools.length });
    if (report.state === "needs-auth") return t("mcp.needsAuth", { name: report.name });
    if (report.state === "disabled") return t("mcp.disabled");
    return `${report.state}${report.error ? `: ${report.error}` : ""}`;
  };

  const form = draft && (
    <form
      className="settings-inline-form settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        void saveDraft(draft);
      }}
    >
      <div className="settings-form-pair">
        <ConfigField label={t("mcp.name")}>
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="filesystem" />
        </ConfigField>
        {projectAvailable && (
          <ConfigField label={t("mcp.scope")}>
            <SettingsSegmented
              label={t("mcp.scope")}
              value={draft.scope}
              onChange={(scope) => setDraft({ ...draft, scope })}
              options={[
                { value: "global", label: t("mcp.scopeGlobal") },
                { value: "project", label: t("mcp.scopeProject"), disabled: !settings.project?.trusted },
              ]}
            />
          </ConfigField>
        )}
      </div>
      <ConfigField label={t("mcp.config")}>
        <textarea
          className="mcp-config-json"
          spellCheck={false}
          value={draft.json}
          onChange={(event) => setDraft({ ...draft, json: event.target.value })}
          placeholder={'{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n}'}
        />
      </ConfigField>
      <p className="settings-row-message">{t("mcp.configHint")}</p>
      <div className="settings-inline-form-actions">
        {draft.previous && (
          <ConfigButton
            size="small"
            variant="ghost"
            className="is-danger-text is-pushed-left"
            disabled={saving}
            onClick={() => {
              const previous = draft.previous!;
              if (!window.confirm(t("agents.deleteConfirm", { name: previous.name }))) return;
              void run(async () => {
                await request("DELETE", { scope: previous.scope, name: previous.name });
                setDraft(null);
              });
            }}
          >
            {t("agents.delete")}
          </ConfigButton>
        )}
        <ConfigButton size="small" disabled={saving} onClick={() => setDraft(null)}>{t("trust.cancel")}</ConfigButton>
        <ConfigButton type="submit" variant="primary" size="small" disabled={saving || !draft.json.trim()}>
          {saving ? t("agents.saving") : t("agents.save")}
        </ConfigButton>
      </div>
    </form>
  );

  return (
    <>
      {reloadNeeded && <ReloadNotice sessionId={sessionId} onReloaded={onReloaded} onDone={() => setReloadNeeded(false)} />}
      <div className="settings-page">
        <SettingsGroup
          title={<CountedTitle label={t("mcp.servers")} count={settings.servers.length} />}
          action={!draft && (
            <span className="settings-group-actions">
              {settings.servers.length > 0 && (
                <ConfigButton size="small" disabled={checking || saving} onClick={() => void runCheck()}>
                  {checking ? t("mcp.checking") : t("mcp.check")}
                </ConfigButton>
              )}
              <ConfigButton size="small" disabled={saving} onClick={() => setDraft({ name: "", scope: "global", json: "" })}>
                {t("mcp.add")}
              </ConfigButton>
            </span>
          )}
        >
          {mcpBuiltin && !mcpBuiltin.enabled && <p className="settings-row-message is-warning">{t("mcp.builtinOff")}</p>}
          {settings.servers.length === 0 && !draft && <p className="settings-row-message">{t("mcp.empty")}</p>}
          {settings.servers.map((server) => (
            draft?.previous && serverKey(draft.previous) === serverKey(server) ? <div key={serverKey(server)}>{form}</div> : (
              <SettingsRow
                key={serverKey(server)}
                stacked
                label={<span className={server.enabled && !server.overridden ? undefined : "is-dim"}>{server.name}</span>}
                description={<span className="mcp-server-description">{describe(server)}</span>}
                title={server.scope === "project" ? settings.project?.path : settings.globalPath}
              >
                <span className="settings-row-hover-actions">
                  <ConfigButton
                    size="small"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => setDraft({
                      name: server.name,
                      scope: server.scope,
                      json: JSON.stringify(server.config, null, 2),
                      previous: { name: server.name, scope: server.scope },
                    })}
                  >
                    {t("i18n.edit")}
                  </ConfigButton>
                </span>
                {server.scope === "project" && <span className="settings-row-status">{t("project.tag.override")}</span>}
                <Select
                  className="select-trigger settings-select"
                  ariaLabel={t("mcp.exposure")}
                  align="end"
                  value={server.exposure}
                  disabled={saving}
                  onChange={(exposure) => void run(() => request("PATCH", { scope: server.scope, name: server.name, exposure }))}
                  options={EXPOSURES.map((value) => ({ value, label: t(`mcp.exposure.${value}`) }))}
                />
                <ConfigSwitch
                  checked={server.enabled}
                  disabled={saving}
                  label={server.name}
                  onChange={(enabled) => void run(() => request("PATCH", { scope: server.scope, name: server.name, enabled }))}
                />
              </SettingsRow>
            )
          ))}
          {draft && !draft.previous && form}
          {settings.errors.concat(check?.errors ?? []).map((message) => (
            <p key={message} role="alert" className="settings-row-message is-error">{message}</p>
          ))}
          {settings.project?.ignored && <p className="settings-row-message is-warning">{t("mcp.projectIgnored")}</p>}
          {check?.note && <p className="settings-row-message is-warning">{check.note}</p>}
          {error && <p role="alert" className="settings-row-message is-error">{error}</p>}
          {settings.servers.length > 0 && <p className="settings-row-message">{t("mcp.signInHint")}</p>}
        </SettingsGroup>

        <SettingsGroup title={t("mcp.builtins")}>
          {settings.builtins.map((builtin) => (
            <SettingsRow key={builtin.name} label={t(`mcp.builtin.${builtin.name}`)} description={t(`mcp.builtin.${builtin.name}.description`)}>
              {builtin.enabled !== builtin.globalEnabled && (
                <span className="settings-row-status" title={t("mcp.projectOverrideHint")}>
                  {builtin.enabled ? t("mcp.onInProject") : t("mcp.offInProject")}
                </span>
              )}
              <ConfigSwitch
                checked={builtin.globalEnabled}
                disabled={saving}
                label={t(`mcp.builtin.${builtin.name}`)}
                onChange={(enabled) => void run(async () => {
                  await request("PATCH", { builtin: builtin.name, enabled });
                  onChanged?.();
                })}
              />
            </SettingsRow>
          ))}
        </SettingsGroup>

        {settings.logTail && (
          <SettingsGroup title={t("mcp.log")}>
            <details className="mcp-log">
              <summary>{t("mcp.logSummary")}</summary>
              <pre>{settings.logTail}</pre>
            </details>
          </SettingsGroup>
        )}
      </div>
    </>
  );
}
