"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useConfirm } from "@/hooks/useConfirm";
import type { McpCheckResponse, McpConfigValue, McpServerView, McpSettingsResponse } from "@/lib/api-types";
import { formatRelativeTime } from "@/lib/i18n/format";
import { parseMcpDraft } from "@/lib/mcp-draft";
import { mcpLogRecords, toolExposureOf } from "@/lib/mcp-view";
import { getJson, peekJson, settingsUrls } from "@/lib/settings-cache";
import { ReloadNotice } from "./ReloadNotice";
import { Select } from "./Select";
import {
  ConfigButton, ConfigField, ConfigStatusDot, ConfigSwitch, CountedTitle, SettingsBackLink, SettingsDetailPage,
  SettingsGroup, SettingsLinkRow, SettingsLoading, SettingsProperties, SettingsProperty, SettingsRow, SettingsSegmented,
} from "./SettingsUi";

const EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;

type Scope = McpServerView["scope"];
type Draft = { name: string; scope: Scope; json: string; notes?: string[]; previous?: { name: string; scope: Scope } };
type CheckReport = McpCheckResponse["servers"][number];
type View = { kind: "list" } | { kind: "detail"; key: string } | { kind: "add" } | { kind: "edit"; back: View };
type Translate = ReturnType<typeof useI18n>["t"];

const serverKey = (server: { name: string; scope: Scope }) => `${server.scope}:${server.name}`;

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

/** One line for a server's state: the last test, else what the files say. */
function stateText(server: McpServerView, report: CheckReport | undefined, t: Translate): { text: string; tone?: "warning" | "danger" } | null {
  if (!server.enabled) return { text: t("mcp.disabled") };
  if (report?.state === "connected") return { text: t("mcp.connected", { count: report.tools.length }) };
  if (report?.state === "needs-auth") return { text: t("mcp.state.needsAuth"), tone: "warning" };
  if (report?.state === "disconnected") return { text: t("mcp.state.disconnected"), tone: "warning" };
  if (report) return { text: t("mcp.state.failed"), tone: "danger" };
  if (server.usesOAuth && server.signedIn) return { text: t("mcp.signedIn") };
  return null;
}

export function McpConfig({ cwd = null, sessionId = null, onReloaded, onChanged }: {
  cwd?: string | null;
  sessionId?: string | null;
  onReloaded?: () => void;
  /** Built-in switches changed what the Project page shows. */
  onChanged?: () => void;
}) {
  const { t, locale } = useI18n();
  const confirm = useConfirm();
  const url = settingsUrls.mcp(cwd);
  const [settings, setSettings] = useState<McpSettingsResponse | null>(() => {
    const reply = peekJson<McpSettingsResponse & { error?: string }>(url);
    return reply?.ok && !reply.data.error ? reply.data : null;
  });
  const [view, setView] = useState<View>({ kind: "list" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Last test per server name (tests reach the effective entry of a name).
  const [reports, setReports] = useState<Map<string, CheckReport>>(new Map());
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [checkNotes, setCheckNotes] = useState<string[]>([]);

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

  const refresh = async () => {
    setSettings(await readJson<McpSettingsResponse>(await fetch(url, { cache: "no-store" })));
  };

  const request = async (method: "PUT" | "PATCH" | "DELETE", body: Record<string, unknown>) => {
    const data = await readJson<McpSettingsResponse>(await fetch("/api/mcp", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, ...(cwd ? { cwd } : {}) }),
    }));
    setSettings(data);
    setReloadNeeded(true);
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

  // Exposure edits keep a test's tool list; a changed, moved, removed, or switched entry drops it.
  const forget = (...names: string[]) => setReports((current) => {
    const next = new Map(current);
    for (const name of names) next.delete(name);
    return next;
  });

  /** Test every enabled server, or the one named. */
  const test = async (name?: string) => {
    const key = name ?? "*";
    setTesting((current) => new Set(current).add(key));
    setError(null);
    try {
      const data = await readJson<McpCheckResponse>(await fetch("/api/mcp/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(cwd ? { cwd } : {}), ...(name ? { name } : {}) }),
      }));
      setReports((current) => {
        const next = name ? new Map(current) : new Map<string, CheckReport>();
        for (const report of data.servers) next.set(report.name, report);
        return next;
      });
      if (!name) setCheckNotes([...data.errors, ...(data.note ? [data.note] : [])]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  };

  const openEditor = (server: McpServerView) => void run(async () => {
    const params = new URLSearchParams({ scope: server.scope, name: server.name, ...(cwd ? { cwd } : {}) });
    const { config } = await readJson<{ config: Record<string, unknown> }>(await fetch(`/api/mcp?${params}`, { cache: "no-store" }));
    setDraft({ name: server.name, scope: server.scope, json: JSON.stringify(config, null, 2), previous: { name: server.name, scope: server.scope } });
    setView({ kind: "edit", back: view });
  });

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
    forget(...entries.map(([name]) => name), ...(current.previous ? [current.previous.name] : []));
    setView(entries.length === 1 ? { kind: "detail", key: serverKey({ name: entries[0]![0], scope: current.scope }) } : { kind: "list" });
    // Only what was just saved: testing everything would start every other server too.
    for (const [name] of entries) void test(name);
  });

  const remove = async (server: McpServerView) => {
    if (!(await confirm(t("mcp.deleteConfirm", { name: server.name }), { danger: true }))) return;
    await run(async () => {
      await request("DELETE", { scope: server.scope, name: server.name });
      forget(server.name);
      setView({ kind: "list" });
    });
  };

  if (!settings) {
    return <div className="settings-page">{error ? <p role="alert" className="settings-row-message is-error">{error}</p> : <SettingsLoading label={t("i18n.loading")} />}</div>;
  }

  const errorLine = error && <p role="alert" className="settings-row-message is-error">{error}</p>;
  const backToList = <SettingsBackLink label={t("settings.mcp")} onClick={() => { setError(null); setView({ kind: "list" }); }} />;
  let content;

  if (view.kind === "add") {
    content = (
      <>
        {backToList}
        <McpAddPaste
          onRead={(next) => { setDraft(next); setView({ kind: "edit", back: { kind: "add" } }); }}
          onWriteJson={() => { setDraft({ name: "", scope: "global", json: "" }); setView({ kind: "edit", back: { kind: "add" } }); }}
        />
      </>
    );
  } else if (view.kind === "edit" && draft) {
    content = (
      <>
        <SettingsBackLink
          label={view.back.kind === "add" ? t("mcp.addTitle") : draft.previous?.name ?? t("settings.mcp")}
          onClick={() => { setDraft(null); setError(null); setView(view.back); }}
        />
        <SettingsDetailPage title={draft.previous ? draft.previous.name : t("mcp.addTitle")}>
          <McpDraftForm
            draft={draft}
            saving={saving}
            projectAvailable={settings.project !== null}
            projectTrusted={settings.project?.trusted === true}
            onChange={setDraft}
            onSave={() => void saveDraft(draft)}
          />
          {errorLine}
        </SettingsDetailPage>
      </>
    );
  } else if (view.kind === "detail" && settings.servers.some((server) => serverKey(server) === view.key)) {
    const server = settings.servers.find((candidate) => serverKey(candidate) === view.key)!;
    content = (
      <>
        {backToList}
        <McpServerDetail
          key={view.key}
          server={server}
          settings={settings}
          cwd={cwd}
          report={server.overridden ? undefined : reports.get(server.name)}
          testing={testing.has(server.name) || testing.has("*")}
          saving={saving}
          onTest={() => void test(server.name)}
          onPatch={(body) => void run(async () => {
            await request("PATCH", body);
            if (body.enabled !== undefined) forget(server.name);
          })}
          onRemoveOverride={() => void run(async () => {
            await request("DELETE", { scope: "project", name: server.name });
            forget(server.name);
          })}
          onSignedChange={() => { void refresh().catch(() => undefined); void test(server.name); }}
          onEdit={() => openEditor(server)}
          onDelete={() => void remove(server)}
        />
        {errorLine}
      </>
    );
  } else {
    const mcpBuiltin = settings.builtins.find((builtin) => builtin.name === "mcp");
    content = (
      <>
        <SettingsGroup
          title={<CountedTitle label={t("mcp.servers")} count={settings.servers.length} />}
          action={(
            <span className="settings-group-actions">
              {settings.servers.length > 0 && (
                <ConfigButton size="small" disabled={testing.size > 0} onClick={() => void test()}>
                  {testing.has("*") ? t("mcp.checking") : t("mcp.check")}
                </ConfigButton>
              )}
              <ConfigButton size="small" onClick={() => { setError(null); setView({ kind: "add" }); }}>{t("mcp.add")}</ConfigButton>
            </span>
          )}
        >
          {mcpBuiltin && !mcpBuiltin.enabled && <p className="settings-row-message is-warning">{t("mcp.builtinOff")}</p>}
          {settings.autoEnableCodemode === false && <p className="settings-row-message is-warning">{t("mcp.autoEnableOff")}</p>}
          {settings.servers.length === 0 && <p className="settings-row-message">{t("mcp.empty")}</p>}
          {settings.servers.map((server) => {
            const state = server.overridden ? { text: t("mcp.overridden") } : stateText(server, reports.get(server.name), t);
            return (
              <SettingsLinkRow
                key={serverKey(server)}
                label={server.name}
                description={[server.transport, state?.text].filter(Boolean).join(" · ")}
                muted={!server.enabled || server.overridden}
                title={server.scope === "project" ? settings.project?.path : settings.globalPath}
                onOpen={() => { setError(null); setView({ kind: "detail", key: serverKey(server) }); }}
              >
                {state?.tone && <ConfigStatusDot tone={state.tone} title={state.text} />}
                {(server.scope === "project" || server.projectOverride) && <span className="settings-row-status">{t("project.tag.override")}</span>}
                <ConfigSwitch
                  checked={server.enabled}
                  disabled={saving || server.overridden}
                  label={server.name}
                  onChange={(enabled) => void run(async () => {
                    await request("PATCH", { ...patchTarget(server), enabled });
                    forget(server.name);
                  })}
                />
              </SettingsLinkRow>
            );
          })}
          {settings.errors.concat(checkNotes).map((message) => (
            <p key={message} role="alert" className="settings-row-message is-error">{message}</p>
          ))}
          {settings.project?.ignored && <p className="settings-row-message is-warning">{t("mcp.projectIgnored")}</p>}
          {errorLine}
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

        {settings.logTail && settings.logModified && (
          <SettingsGroup title={t("mcp.log")}>
            <details className="mcp-log">
              <summary title={new Date(settings.logModified).toLocaleString(locale)}>
                {t("mcp.logSummary", { time: formatRelativeTime(settings.logModified, locale) })}
              </summary>
              <pre>{settings.logTail}</pre>
            </details>
          </SettingsGroup>
        )}
      </>
    );
  }

  return (
    <>
      {reloadNeeded && <ReloadNotice sessionId={sessionId} onReloaded={onReloaded} onDone={() => setReloadNeeded(false)} />}
      <div key={view.kind} className="settings-page">{content}</div>
    </>
  );
}

/** Where a server's switches write: its project override when there is one (pi's /mcp does the same). */
function patchTarget(server: McpServerView) {
  return server.projectOverride
    ? { scope: "project" as const, name: server.name, override: true }
    : { scope: server.scope, name: server.name };
}

function describeValue(value: McpConfigValue, t: Translate): string {
  if (value.kind === "env") return `${value.name} — ${t("mcp.value.env", { vars: value.detail ?? "" })}`;
  if (value.kind === "command") return `${value.name} — ${t("mcp.value.command")}`;
  return `${value.name} — ${t("mcp.value.literal")}`;
}

function McpServerDetail({ server, settings, cwd, report, testing, saving, onTest, onPatch, onRemoveOverride, onSignedChange, onEdit, onDelete }: {
  server: McpServerView;
  settings: McpSettingsResponse;
  cwd: string | null;
  report: CheckReport | undefined;
  testing: boolean;
  saving: boolean;
  onTest: () => void;
  onPatch: (body: Record<string, unknown>) => void;
  onRemoveOverride: () => void;
  onSignedChange: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t, locale } = useI18n();
  const target = patchTarget(server);
  const path = server.scope === "project" ? settings.project?.path ?? "" : settings.globalPath;
  const canOverride = server.scope === "global" && !server.overridden && settings.project?.trusted === true;
  const state = server.overridden ? { text: t("mcp.overridden") } : stateText(server, report, t) ?? { text: t("mcp.state.untested") };
  const valueLines = (values: McpConfigValue[]) => values.map((value) => <div key={value.name}>{describeValue(value, t)}</div>);
  const exposureOptions = EXPOSURES.map((value) => ({ value, label: t(`mcp.exposure.${value}`) }));
  // Rules no listed tool name matches exactly: patterns, or tools the server no longer offers.
  const otherRules = Object.entries(server.toolExposure).filter(([rule]) => !report?.tools.some((tool) => tool.name === rule));
  const log = settings.logTail ? mcpLogRecords(settings.logTail, server.name) : "";

  return (
    <SettingsDetailPage
      title={server.name}
      meta={(
        <>
          <span className={`config-scope-tag${server.scope === "project" ? " is-project" : ""}`}>
            {server.scope === "project" ? t("mcp.scopeProject") : t("mcp.scopeGlobal")}
          </span>
          <span className="config-detail-path" title={path}>{path}</span>
        </>
      )}
      description={server.description}
    >
      <SettingsGroup>
        <SettingsRow
          label={t("mcp.enabledLabel")}
          description={server.overridden ? t("mcp.overridden") : server.projectOverride ? t("mcp.savedTo", { path: settings.project?.path ?? "" }) : undefined}
        >
          <ConfigSwitch
            checked={server.enabled}
            disabled={saving || server.overridden}
            label={t("mcp.enabledLabel")}
            onChange={(enabled) => onPatch({ ...target, enabled })}
          />
        </SettingsRow>
        <SettingsRow label={t("mcp.connection")} description={state.text}>
          {!server.overridden && server.enabled && (
            <ConfigButton size="small" disabled={testing} onClick={onTest}>{testing ? t("mcp.testing") : t("mcp.test")}</ConfigButton>
          )}
        </SettingsRow>
        {/* A needs-auth error only says to sign in, which the Sign-in group offers. */}
        {report?.error && report.state !== "connected" && report.state !== "needs-auth" && <pre className="mcp-error">{report.error}</pre>}
        {report?.instructions && (
          <SettingsRow stacked label={t("mcp.instructions")} description={<span className="mcp-server-description">{report.instructions}</span>} />
        )}
      </SettingsGroup>

      {(server.usesOAuth || server.authProvider) && (
        <SettingsGroup title={t("mcp.signIn")}>
          {server.authProvider ? (
            <p className="settings-row-message">{t("mcp.authProviderHint", { provider: server.authProvider })}</p>
          ) : (
            <McpSignIn server={server} cwd={cwd} disabled={server.overridden || !server.enabled} onChanged={onSignedChange} />
          )}
        </SettingsGroup>
      )}

      <SettingsGroup title={t("mcp.tools")}>
        <SettingsRow label={t("mcp.exposure")} description={t(`mcp.exposure.${server.exposure}.description`)}>
          <Select
            className="select-trigger settings-select"
            ariaLabel={t("mcp.exposure")}
            align="end"
            value={server.exposure}
            disabled={saving || server.overridden}
            onChange={(exposure) => onPatch({ ...target, exposure })}
            options={exposureOptions}
          />
        </SettingsRow>
        {!report || report.state !== "connected" ? (
          <p className="settings-row-message">{t("mcp.toolsUntested")}</p>
        ) : report.tools.length === 0 ? (
          <p className="settings-row-message">{t("mcp.toolsNone")}</p>
        ) : report.tools.map((tool) => {
          const exact = Object.hasOwn(server.toolExposure, tool.name) ? server.toolExposure[tool.name]! : "";
          const others = Object.fromEntries(Object.entries(server.toolExposure).filter(([rule]) => rule !== tool.name));
          const inherited = toolExposureOf(others, server.exposure, tool.name);
          return (
            <SettingsRow
              key={tool.name}
              label={(
                <>
                  {tool.name}
                  {tool.readOnly && <span className="settings-row-tag">{t("mcp.tag.readOnly")}</span>}
                  {tool.destructive && <span className="settings-row-tag">{t("mcp.tag.destructive")}</span>}
                </>
              )}
              description={tool.description && <span className="mcp-tool-description" title={tool.description}>{tool.description}</span>}
            >
              <Select
                className="select-trigger settings-select"
                ariaLabel={`${t("mcp.exposure")}: ${tool.name}`}
                align="end"
                value={exact}
                disabled={saving || server.overridden}
                onChange={(exposure) => onPatch({ ...target, toolExposure: { [tool.name]: exposure || null } })}
                options={[{ value: "", label: t("mcp.toolDefault", { exposure: t(`mcp.exposure.${inherited}`) }) }, ...exposureOptions]}
              />
            </SettingsRow>
          );
        })}
        {otherRules.length > 0 && (
          <p className="settings-row-message">{t("mcp.rules", { rules: otherRules.map(([rule, exposure]) => `${rule} → ${exposure}`).join(", ") })}</p>
        )}
        {report?.resources && <p className="settings-row-message">{t("mcp.resources")}</p>}
      </SettingsGroup>

      <SettingsGroup title={t("mcp.details")}>
        <SettingsProperties>
          <SettingsProperty label={server.type === "http" ? t("mcp.prop.url") : t("mcp.prop.command")}>
            <span className="mcp-server-description">{server.transport}</span>
          </SettingsProperty>
          {server.cwd && <SettingsProperty label={t("mcp.prop.cwd")}>{server.cwd}</SettingsProperty>}
          {server.timeout !== undefined && <SettingsProperty label={t("mcp.prop.timeout")}>{t("mcp.timeoutValue", { count: server.timeout })}</SettingsProperty>}
          {server.env.length > 0 && <SettingsProperty label={t("mcp.prop.env")}>{valueLines(server.env)}</SettingsProperty>}
          {server.headers.length > 0 && <SettingsProperty label={t("mcp.prop.headers")}>{valueLines(server.headers)}</SettingsProperty>}
          {server.oauth && server.oauth.length > 0 && <SettingsProperty label={t("mcp.prop.oauth")}>{server.oauth.join(", ")}</SettingsProperty>}
          {server.clientSecret && <SettingsProperty label={t("mcp.prop.clientSecret")}>{describeValue(server.clientSecret, t)}</SettingsProperty>}
        </SettingsProperties>
        {/\/sse\/?(\?|$)/.test(server.transport) && <p className="settings-row-message is-warning">{t("mcp.sseHint")}</p>}
        {(server.env.length > 0 || server.headers.length > 0 || server.clientSecret) && <p className="settings-row-message">{t("mcp.secretsHidden")}</p>}
      </SettingsGroup>

      {(canOverride || server.projectOverride) && (
        <SettingsGroup>
          <SettingsRow label={t("mcp.thisProject")} description={server.projectOverride ? t("mcp.projectOverride") : t("mcp.thisProjectDescription")}>
            <ConfigButton
              size="small"
              disabled={saving}
              onClick={() => server.projectOverride ? onRemoveOverride() : onPatch({ scope: "project", name: server.name, override: true, enabled: !server.enabled })}
            >
              {server.projectOverride ? t("mcp.resetInProject") : server.enabled ? t("mcp.disableInProject") : t("mcp.enableInProject")}
            </ConfigButton>
          </SettingsRow>
        </SettingsGroup>
      )}

      {settings.logModified && (
        <SettingsGroup title={t("mcp.log")}>
          {log ? (
            <details className="mcp-log">
              <summary title={new Date(settings.logModified).toLocaleString(locale)}>
                {t("mcp.logSummary", { time: formatRelativeTime(settings.logModified, locale) })}
              </summary>
              <pre>{log}</pre>
            </details>
          ) : <p className="settings-row-message">{t("mcp.log.empty")}</p>}
        </SettingsGroup>
      )}

      <SettingsGroup>
        <SettingsRow label={t("mcp.editJson")} description={t("mcp.editJsonDescription")}>
          <ConfigButton size="small" disabled={saving} onClick={onEdit}>{t("i18n.edit")}</ConfigButton>
        </SettingsRow>
        <SettingsRow label={t("i18n.delete")} description={t("mcp.deleteDescription")}>
          <ConfigButton variant="danger" size="small" disabled={saving} onClick={onDelete}>{t("i18n.delete")}</ConfigButton>
        </SettingsRow>
      </SettingsGroup>
    </SettingsDetailPage>
  );
}

type SignInState =
  | { phase: "idle" | "connecting" | "finishing" }
  | { phase: "auth"; url: string; token: string; invalid?: boolean }
  | { phase: "done" | "error"; message: string };

/** `pi mcp login` from Settings: the server runs the flow; a remote browser pastes the redirected address back. */
function McpSignIn({ server, cwd, disabled, onChanged }: { server: McpServerView; cwd: string | null; disabled: boolean; onChanged: () => void }) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [state, setState] = useState<SignInState>({ phase: "idle" });
  const [paste, setPaste] = useState("");
  const source = useRef<EventSource | null>(null);
  useEffect(() => () => source.current?.close(), []);

  const start = () => {
    source.current?.close();
    setPaste("");
    setState({ phase: "connecting" });
    const params = new URLSearchParams({ name: server.name, ...(cwd ? { cwd } : {}) });
    const events = new EventSource(`/api/mcp/sign-in?${params}`);
    source.current = events;
    events.onmessage = (message) => {
      const event = JSON.parse(message.data) as { type: string; url?: string; token?: string; tools?: number; already?: boolean; message?: string };
      if (event.type === "auth") setState({ phase: "auth", url: event.url!, token: event.token! });
      else if (event.type === "finishing") setState({ phase: "finishing" });
      else {
        events.close();
        if (event.type === "success") {
          setState({ phase: "done", message: t(event.already ? "mcp.signInAlready" : "mcp.signInDone", { count: event.tools ?? 0 }) });
          onChanged();
        } else if (event.type === "cancelled") setState({ phase: "idle" });
        else setState({ phase: "error", message: event.message ?? "" });
      }
    };
    events.onerror = () => {
      events.close();
      setState((current) => current.phase === "done" || current.phase === "error" ? current : { phase: "error", message: t("mcp.signInLost") });
    };
  };

  const cancel = () => {
    source.current?.close();
    setState({ phase: "idle" });
  };

  const submit = async (token: string) => {
    const response = await fetch("/api/mcp/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, redirectUrl: paste }),
    }).catch(() => null);
    if (!response?.ok) setState((current) => current.phase === "auth" && current.token === token ? { ...current, invalid: true } : current);
  };

  const signOut = async () => {
    if (!(await confirm(t("mcp.signOutConfirm", { name: server.name }), { danger: true }))) return;
    try {
      await readJson(await fetch("/api/mcp/sign-in", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: server.name, ...(cwd ? { cwd } : {}) }),
      }));
      setState({ phase: "idle" });
      onChanged();
    } catch (cause) {
      setState({ phase: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const busy = state.phase === "connecting" || state.phase === "auth" || state.phase === "finishing";
  return (
    <>
      <SettingsRow label={server.signedIn ? t("mcp.signedIn") : t("mcp.notSignedIn")} description={server.signedIn || state.phase !== "idle" ? undefined : t("mcp.signInDescription")}>
        {busy ? (
          <ConfigButton size="small" onClick={cancel}>{t("i18n.cancel")}</ConfigButton>
        ) : (
          <>
            {server.signedIn && <ConfigButton size="small" variant="ghost" disabled={disabled} onClick={() => void signOut()}>{t("mcp.signOut")}</ConfigButton>}
            <ConfigButton size="small" variant={server.signedIn ? "secondary" : "primary"} disabled={disabled} onClick={start}>{t("mcp.signInAction")}</ConfigButton>
          </>
        )}
      </SettingsRow>
      {state.phase === "connecting" && <p role="status" className="settings-row-message">{t("mcp.signInConnecting")}</p>}
      {state.phase === "finishing" && <p role="status" className="settings-row-message">{t("mcp.signInFinishing")}</p>}
      {state.phase === "auth" && (
        <form className="settings-inline-form settings-form" onSubmit={(event) => { event.preventDefault(); void submit(state.token); }}>
          <p className="settings-row-message">
            <a href={state.url} target="_blank" rel="noreferrer" className="settings-link">{t("mcp.signInOpen")} ↗</a>
          </p>
          <p className="settings-row-message">{t("mcp.signInWaiting")}</p>
          <ConfigField label={t("mcp.signInPaste")}>
            <input value={paste} onChange={(event) => setPaste(event.target.value)} placeholder="http://127.0.0.1:…/callback?code=…" spellCheck={false} />
          </ConfigField>
          {state.invalid && <p role="alert" className="settings-row-message is-error">{t("mcp.signInInvalid")}</p>}
          <div className="settings-inline-form-actions">
            <ConfigButton type="submit" variant="primary" size="small" disabled={!paste.trim()}>{t("mcp.signInContinue")}</ConfigButton>
          </div>
        </form>
      )}
      {state.phase === "done" && <p role="status" className="settings-row-message">{state.message}</p>}
      {state.phase === "error" && <p role="alert" className="settings-row-message is-error">{state.message}</p>}
    </>
  );
}

/** Paste anything a server's docs offer; the server parses it into entries for the JSON form to review. */
function McpAddPaste({ onRead, onWriteJson }: { onRead: (draft: Draft) => void; onWriteJson: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = async () => {
    setReading(true);
    setError(null);
    try {
      const data = await readJson<{ servers: { name: string; config: Record<string, unknown> }[]; notes: string[] }>(await fetch("/api/mcp/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }));
      if (data.servers.length === 0) throw new Error(data.notes.join("\n") || "No server config found");
      const [only] = data.servers;
      onRead(data.servers.length === 1
        ? { name: only!.name, scope: "global", json: JSON.stringify(only!.config, null, 2), notes: data.notes }
        : { name: "", scope: "global", json: JSON.stringify({ mcpServers: Object.fromEntries(data.servers.map((server) => [server.name, server.config])) }, null, 2), notes: data.notes });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReading(false);
    }
  };

  return (
    <SettingsDetailPage title={t("mcp.addTitle")}>
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void read(); }}>
        <ConfigField label={t("mcp.pasteLabel")}>
          <textarea
            className="mcp-config-json"
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={"https://mcp.example.com/mcp\nnpx -y @modelcontextprotocol/server-filesystem .\nclaude mcp add --transport http docs https://…\n{ \"mcpServers\": { … } }"}
          />
        </ConfigField>
        {error && <p role="alert" className="settings-row-message is-error mcp-server-description">{error}</p>}
        <div className="settings-inline-form-actions">
          <ConfigButton size="small" variant="ghost" className="is-pushed-left" onClick={onWriteJson}>{t("mcp.writeJson")}</ConfigButton>
          <ConfigButton type="submit" variant="primary" size="small" disabled={reading || !text.trim()}>
            {reading ? t("mcp.pasteReading") : t("mcp.pasteContinue")}
          </ConfigButton>
        </div>
      </form>
    </SettingsDetailPage>
  );
}

function McpDraftForm({ draft, saving, projectAvailable, projectTrusted, onChange, onSave }: {
  draft: Draft;
  saving: boolean;
  projectAvailable: boolean;
  projectTrusted: boolean;
  onChange: (draft: Draft) => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  return (
    <form className="settings-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      {draft.notes?.map((note) => <p key={note} className="settings-row-message is-warning">{note}</p>)}
      <div className="settings-form-pair">
        <ConfigField label={t("mcp.name")}>
          <input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} placeholder="filesystem" />
        </ConfigField>
        {projectAvailable && (
          <ConfigField label={t("mcp.scope")}>
            <SettingsSegmented
              label={t("mcp.scope")}
              value={draft.scope}
              onChange={(scope) => onChange({ ...draft, scope })}
              options={[
                { value: "global", label: t("mcp.scopeGlobal") },
                { value: "project", label: t("mcp.scopeProject"), disabled: !projectTrusted },
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
          onChange={(event) => onChange({ ...draft, json: event.target.value })}
          placeholder={'{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n}'}
        />
      </ConfigField>
      <p className="settings-row-message">{t("mcp.configHint")}</p>
      <div className="settings-inline-form-actions">
        <ConfigButton type="submit" variant="primary" size="small" disabled={saving || !draft.json.trim()}>
          {saving ? t("agents.saving") : t("agents.save")}
        </ConfigButton>
      </div>
    </form>
  );
}
