"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getJson, peekJson, settingsUrls } from "@/lib/settings-cache";
import { sendAgentCommand } from "@/lib/agent-client";
import { IMAGE_CUSTOM_MODEL_PRESETS } from "@/lib/image-generation";
import type {
  ImageGenerationSettingsConnection,
  ImageGenerationSettingsProvider,
  ImageGenerationSettingsResponse,
} from "@/lib/api-types";
import { ConfigButton, ConfigSwitch, CountedTitle, SettingsGroup, SettingsLoading, SettingsRow } from "./SettingsUi";

type Draft =
  | { mode: "edit"; id: string; label: string; provider: string; model: string }
  | { mode: "create"; label: string; provider: string; model: string };

const BUILTIN_IMAGE_PROVIDERS = new Set(["openai-codex", "antigravity", "xai"]);

function preferredCustomProvider(providers: readonly ImageGenerationSettingsProvider[]): string {
  return providers.find((provider) => !BUILTIN_IMAGE_PROVIDERS.has(provider.id))?.id ?? providers[0]?.id ?? "";
}

export function ImagesConfig({
  sessionId = null,
  onReloaded,
}: {
  sessionId?: string | null;
  onReloaded?: () => void;
}) {
  const { t } = useI18n();
  // The last reply paints at once; the mount load then revalidates it.
  const [settings, setSettings] = useState<ImageGenerationSettingsResponse | null>(() => {
    const reply = peekJson<Partial<ImageGenerationSettingsResponse> & { error?: string }>(settingsUrls.imageSettings);
    return reply?.ok && !reply.data.error ? normalizeSettings(reply.data) : null;
  });
  const [loading, setLoading] = useState(settings === null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rename, setRename] = useState<{ id: string; label: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void (async () => {
      try {
        const response = await getJson<Partial<ImageGenerationSettingsResponse> & { error?: string }>(settingsUrls.imageSettings);
        if (controller.signal.aborted) return;
        const data = response.data;
        if (!response.ok || data.error || typeof data.enabled !== "boolean" || !Array.isArray(data.connections)) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        const next = normalizeSettings(data);
        setSettings(next);
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const applyResponse = async (response: Response) => {
    const data = await response.json() as Partial<ImageGenerationSettingsResponse> & { error?: string };
    if (!response.ok || data.error || typeof data.enabled !== "boolean" || !Array.isArray(data.connections)) {
      throw new Error(data.error ?? `HTTP ${response.status}`);
    }
    setSettings(normalizeSettings(data));
    setReloadNeeded(Boolean(sessionId));
  };

  const save = async (body: { enabled?: boolean; default?: string; connections?: Record<string, { enabled: boolean }> }) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/image-generation/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await applyResponse(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const saveRename = async () => {
    if (!rename || !rename.label.trim()) {
      setRename(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/image-generation/settings/connections", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rename.id, label: rename.label.trim() }),
      });
      await applyResponse(response);
      setRename(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/image-generation/settings/connections", {
        method: draft.mode === "edit" ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft.mode === "edit"
          ? { id: draft.id, label: draft.label, provider: draft.provider, model: draft.model }
          : { label: draft.label, provider: draft.provider, model: draft.model }),
      });
      await applyResponse(response);
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const removeCustom = async (connection: ImageGenerationSettingsConnection) => {
    if (!window.confirm(t("agents.deleteConfirm", { name: connection.label }))) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/image-generation/settings/connections", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: connection.id }),
      });
      await applyResponse(response);
      if (draft?.mode === "edit" && draft.id === connection.id) setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const reloadSession = async () => {
    if (!sessionId) return;
    setReloading(true);
    setError(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      setReloadNeeded(false);
      onReloaded?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReloading(false);
    }
  };

  const builtin = settings?.connections.filter((connection) => connection.kind !== "custom") ?? [];
  const custom = settings?.connections.filter((connection) => connection.kind === "custom") ?? [];
  const providers = settings?.providers ?? [];

  // The connection form opens in place: under "Custom" for a new one, in its own row when editing.
  const editedConnection = draft?.mode === "edit" ? custom.find((connection) => connection.id === draft.id) : undefined;
  const draftForm = draft && (
              <form
                className="settings-inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveDraft();
                }}
              >
                <label className="settings-field">
                  <span>{t("settings.imagesLabel")}</span>
                  <input
                    value={draft.label}
                    onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                    required
                  />
                </label>
                <label className="settings-field">
                  <span>{t("settings.imagesProvider")}</span>
                  <select
                    value={draft.provider}
                    onChange={(event) => setDraft({ ...draft, provider: event.target.value })}
                    required
                  >
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name === provider.id ? provider.id : `${provider.name} (${provider.id})`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>{t("settings.imagesModel")}</span>
                  <ModelPicker
                    key={draft.mode === "edit" ? draft.id : "create"}
                    value={draft.model}
                    t={t}
                    onChange={(model) => {
                      const preset = IMAGE_CUSTOM_MODEL_PRESETS.find((item) => item.model === model);
                      setDraft({
                        ...draft,
                        model,
                        ...(draft.mode === "create" && !draft.label.trim() && preset ? { label: preset.label } : {}),
                      });
                    }}
                  />
                </label>
                <div className="settings-inline-form-actions">
                  {editedConnection && (
                    <ConfigButton type="button" size="small" variant="ghost" className="is-danger-text is-pushed-left" disabled={saving} onClick={() => void removeCustom(editedConnection)}>
                      {t("agents.delete")}
                    </ConfigButton>
                  )}
                  <ConfigButton type="button" size="small" disabled={saving} onClick={() => setDraft(null)}>
                    {t("trust.cancel")}
                  </ConfigButton>
                  <ConfigButton type="submit" variant="primary" size="small" disabled={saving || !draft.label.trim() || !draft.provider || !draft.model.trim()}>
                    {saving ? t("agents.saving") : t("agents.save")}
                  </ConfigButton>
                </div>
              </form>
  );

  if (loading && !settings) return <div key="loading" className="settings-page"><SettingsLoading label={t("i18n.loading")} /></div>;

  return (
    <div key="ready" className="settings-page">
      <SettingsGroup>
        <SettingsRow label={t("settings.imagesEnabled")} description={t("settings.imagesDescription")}>
          {reloadNeeded && sessionId && (
            <ConfigButton size="small" onClick={() => void reloadSession()} disabled={reloading || saving}>
              {reloading ? t("agents.reloading") : t("agents.reloadSession")}
            </ConfigButton>
          )}
          <ConfigSwitch
            checked={settings?.enabled === true}
            disabled={loading || reloading || !settings}
            loading={saving && !draft && !rename}
            label={t("settings.imagesEnabled")}
            onChange={(enabled) => void save({ enabled })}
          />
        </SettingsRow>
        {settings?.enabled && settings.connections.some((connection) => connection.enabled) && (
          <SettingsRow label={t("settings.imagesDefault")} description={t("settings.imagesDefaultDescription")}>
            <select
              className="settings-select"
              value={settings.defaultConnection}
              disabled={loading || saving || reloading}
              onChange={(event) => void save({ default: event.target.value })}
            >
              {settings.connections.filter((connection) => connection.enabled).map((connection) => (
                <option key={connection.id} value={connection.id} disabled={!connection.signedIn}>
                  {connection.label}{connection.signedIn ? "" : ` (${t("settings.imagesSignedOut")})`}
                </option>
              ))}
            </select>
          </SettingsRow>
        )}
        {reloadNeeded && <p role="status" className="settings-row-message is-warning">{t("agents.reloadRequired")}</p>}
        {error && <p role="alert" className="settings-row-message is-error">{error}</p>}
      </SettingsGroup>

      {settings?.enabled && (
        <>
          <SettingsGroup title={<CountedTitle label={t("settings.imagesBuiltin")} count={builtin.length} />}>
            {builtin.map((connection) => (
              <ConnectionSwitch
                key={connection.id}
                connection={connection}
                disabled={loading || reloading || saving}
                unsignedLabel={t("settings.imagesSignedOut")}
                onChange={(enabled) => void save({ connections: { [connection.id]: { enabled } } })}
                renaming={rename?.id === connection.id}
                renameValue={rename?.id === connection.id ? rename.label : connection.label}
                onRenameChange={(label) => setRename({ id: connection.id, label })}
                onRenameSubmit={() => void saveRename()}
                onRenameCancel={() => setRename(null)}
                onEdit={() => { setDraft(null); setRename({ id: connection.id, label: connection.label }); }}
                editLabel={t("i18n.rename")}
              />
            ))}
          </SettingsGroup>

          <SettingsGroup
            title={<CountedTitle label={t("settings.imagesCustom")} count={custom.length} />}
            action={providers.length > 0 && !draft && (
              <ConfigButton
                size="small"
                disabled={loading || reloading || saving}
                onClick={() => {
                  setRename(null);
                  setDraft({
                    mode: "create",
                    label: "",
                    provider: preferredCustomProvider(providers),
                    model: "",
                  });
                }}
              >
                {t("settings.imagesAddConnection")}
              </ConfigButton>
            )}
          >
            {providers.length === 0 && (
              <p className="settings-row-message">{t("settings.imagesNoProviders")}</p>
            )}
            {custom.map((connection) => (
              <Fragment key={connection.id}>
                {draft?.mode === "edit" && draft.id === connection.id ? draftForm : (
                  <ConnectionSwitch
                    connection={connection}
                    disabled={loading || reloading || saving}
                    unsignedLabel={t("settings.imagesNotConfigured")}
                    detail={connection.model}
                    onChange={(enabled) => void save({ connections: { [connection.id]: { enabled } } })}
                    onEdit={() => {
                      setRename(null);
                      setDraft({
                        mode: "edit",
                        id: connection.id,
                        label: connection.label,
                        provider: connection.provider,
                        model: connection.model,
                      });
                    }}
                    editLabel={t("image.edit")}
                  />
                )}
              </Fragment>
            ))}
            {draft?.mode === "create" && draftForm}
          </SettingsGroup>
        </>
      )}
    </div>
  );
}

function normalizeSettings(data: Partial<ImageGenerationSettingsResponse>): ImageGenerationSettingsResponse {
  return {
    enabled: data.enabled === true,
    defaultConnection: data.defaultConnection ?? "",
    connections: (data.connections ?? []).map((connection) => ({
      ...connection,
      model: connection.model ?? "",
      kind: connection.kind === "custom" ? "custom" : "builtin",
    })),
    providers: (data.providers ?? []).filter((provider): provider is ImageGenerationSettingsProvider => (
      Boolean(provider && typeof provider.id === "string" && provider.id)
    )),
  };
}

function ConnectionSwitch({
  connection,
  disabled,
  unsignedLabel,
  detail,
  onChange,
  onEdit,
  editLabel,
  renaming = false,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
}: {
  connection: ImageGenerationSettingsConnection;
  disabled: boolean;
  unsignedLabel: string;
  detail?: string;
  onChange: (enabled: boolean) => void;
  onEdit?: () => void;
  editLabel?: string;
  renaming?: boolean;
  renameValue?: string;
  onRenameChange?: (value: string) => void;
  onRenameSubmit?: () => void;
  onRenameCancel?: () => void;
}) {
  const skipBlur = useRef(false);
  const lockedOff = !connection.signedIn && !connection.enabled;
  const label = renaming ? (
    <input
      className="settings-inline-input"
      value={renameValue}
      autoFocus
      aria-label={editLabel}
      onChange={(event) => onRenameChange?.(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          skipBlur.current = true;
          onRenameSubmit?.();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          skipBlur.current = true;
          onRenameCancel?.();
        }
      }}
      onBlur={() => {
        if (skipBlur.current) {
          skipBlur.current = false;
          return;
        }
        onRenameSubmit?.();
      }}
    />
  ) : (
    <span className={connection.signedIn ? undefined : "is-dim"}>{connection.label}</span>
  );
  return (
    <SettingsRow label={label} description={connection.signedIn ? detail : unsignedLabel}>
      <span className="settings-row-hover-actions">
        {onEdit && !renaming ? (
          <ConfigButton size="small" variant="ghost" disabled={disabled} onClick={onEdit}>
            {editLabel}
          </ConfigButton>
        ) : null}
      </span>
      <ConfigSwitch
        checked={connection.enabled}
        disabled={disabled || lockedOff}
        label={connection.label}
        onChange={onChange}
      />
    </SettingsRow>
  );
}

const OTHER_MODEL = "__other__";

function ModelPicker({
  value,
  onChange,
  t,
}: {
  value: string;
  onChange: (value: string) => void;
  t: (key: string) => string;
}) {
  const known = IMAGE_CUSTOM_MODEL_PRESETS.some((item) => item.model === value);
  const [manual, setManual] = useState(!known);
  const selected = manual || !known ? OTHER_MODEL : value;
  return (
    <>
      <select
        value={selected}
        onChange={(event) => {
          const next = event.target.value;
          if (next === OTHER_MODEL) {
            setManual(true);
            return;
          }
          setManual(false);
          onChange(next);
        }}
      >
        {IMAGE_CUSTOM_MODEL_PRESETS.map((item) => (
          <option key={item.model} value={item.model}>
            {item.label} · {item.model}
          </option>
        ))}
        <option value={OTHER_MODEL}>{t("settings.imagesOtherModel")}</option>
      </select>
      {selected === OTHER_MODEL ? (
        <input value={value} onChange={(event) => onChange(event.target.value)} required />
      ) : null}
    </>
  );
}
