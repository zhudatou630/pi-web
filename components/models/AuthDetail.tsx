"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "../SettingsUi";
import { Notice, SecretTextInput } from "./fields";
import type { ApiKeyProvider, OAuthProvider } from "./types";

type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null; token: string }
  | { phase: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success" }
  | { phase: "error"; message: string };

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Auth routes describe providers from the same composed runtime as chat, which needs the cwd. */
function authCwdQuery(cwd: string | null): string {
  return cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
}

function confirmProviderDisconnect(t: Translate, name: string): boolean {
  return window.confirm(t("models.disconnectConfirm", { name }));
}

export function StatusPill({ tone, children }: { tone: "success" | "muted" | "danger"; children: React.ReactNode }) {
  return (
    <span className={`models-status is-${tone}`}>
      <span className="models-status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

export function OAuthDetail({ provider, onRefresh, cwd }: {
  provider: OAuthProvider;
  onRefresh: () => void;
  cwd: string | null;
}) {
  const [loginState, setLoginState] = useState<OAuthLoginState>({ phase: "idle" });
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loginState.phase === "auth" || loginState.phase === "prompt") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [loginState.phase]);

  // Reset state when provider changes
  useEffect(() => {
    setLoginState({ phase: "idle" });
    setInputValue("");
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [provider.id]);

  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

  const handleLogin = useCallback(() => {
    eventSourceRef.current?.close();
    setLoginState({ phase: "connecting" });
    setInputValue("");

    const es = new EventSource(`/api/auth/login/${encodeURIComponent(provider.id)}${authCwdQuery(cwd)}`);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as {
        type: string; url?: string; instructions?: string | null;
        token?: string; message?: string; placeholder?: string | null;
        userCode?: string; verificationUri?: string; intervalSeconds?: number | null; expiresInSeconds?: number | null;
        options?: { id: string; label: string }[];
      };
      if (data.type === "auth") {
        setLoginState({ phase: "auth", url: data.url!, instructions: data.instructions ?? null, token: data.token! });
        window.open(data.url!, "_blank", "noopener,noreferrer");
      } else if (data.type === "device_code") {
        setLoginState({
          phase: "device_code",
          userCode: data.userCode!,
          verificationUri: data.verificationUri!,
          intervalSeconds: data.intervalSeconds ?? null,
          expiresInSeconds: data.expiresInSeconds ?? null,
        });
        window.open(data.verificationUri!, "_blank", "noopener,noreferrer");
      } else if (data.type === "prompt_request") {
        setLoginState({ phase: "prompt", message: data.message!, placeholder: data.placeholder ?? null, token: data.token! });
      } else if (data.type === "select_request") {
        setLoginState({ phase: "select", message: data.message!, options: data.options ?? [], token: data.token! });
      } else if (data.type === "progress") {
        setLoginState({ phase: "progress", message: data.message! });
      } else if (data.type === "success") {
        es.close();
        setLoginState({ phase: "success" });
        onRefresh();
      } else if (data.type === "error") {
        es.close();
        setLoginState({ phase: "error", message: data.message! });
      } else if (data.type === "cancelled") {
        es.close();
        setLoginState({ phase: "idle" });
      }
    };
    es.onerror = () => {
      es.close();
      setLoginState((prev) => prev.phase === "success" ? prev : { phase: "error", message: t("models.loginConnectionLost") });
    };
  }, [provider.id, onRefresh, cwd, t]);

  const handleLogout = useCallback(async () => {
    if (!confirmProviderDisconnect(t, provider.name)) return;
    await fetch(`/api/auth/logout/${encodeURIComponent(provider.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    setLoginState({ phase: "idle" });
    onRefresh();
  }, [provider.id, provider.name, onRefresh, t, cwd]);

  const postLoginInput = useCallback(async (token: string, code: string, progress: string) => {
    setLoginState({ phase: "progress", message: progress });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setLoginState({ phase: "error", message: d.error ?? `HTTP ${res.status}` });
        return;
      }
      setInputValue("");
      // Success path: SSE stream will emit "success" and update state
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [provider.id]);

  const submitCode = (token: string, code: string) => {
    if (!code.trim()) return;
    void postLoginInput(token, code.trim(), t("models.loginVerifying"));
  };

  const isWorking = loginState.phase === "connecting" || loginState.phase === "progress" ||
    loginState.phase === "auth" || loginState.phase === "device_code" ||
    loginState.phase === "prompt" || loginState.phase === "select";

  return (
    <div className="models-auth">
      <div className="models-auth-row">
        <div className="models-auth-copy">
          <strong>{t("models.oauthTitle")}</strong>
          <StatusPill tone={provider.loggedIn ? "success" : "muted"}>
            {provider.loggedIn ? t("i18n.connected") : t("i18n.notConnected")}
          </StatusPill>
        </div>
        <div className="models-auth-actions">
          {isWorking ? (
            <ConfigButton size="small" onClick={() => { eventSourceRef.current?.close(); setLoginState({ phase: "idle" }); }}>
              {t("i18n.cancel")}
            </ConfigButton>
          ) : (
            <>
              {provider.loggedIn && (
                <ConfigButton size="small" variant="ghost" className="models-danger-ghost" onClick={handleLogout}>{t("i18n.disconnect")}</ConfigButton>
              )}
              <ConfigButton size="small" variant={provider.loggedIn ? "secondary" : "primary"} onClick={handleLogin}>
                {provider.loggedIn ? t("i18n.relogin") : t("i18n.login")}
              </ConfigButton>
            </>
          )}
        </div>
      </div>

      {loginState.phase === "idle" && !provider.loggedIn && (
        <p className="models-muted">{t("models.oauthConnectHint", { name: provider.name })}</p>
      )}
      {loginState.phase === "connecting" && <p className="models-muted">{t("i18n.openingBrowser")}</p>}
      {loginState.phase === "select" && (
        <div className="models-auth-flow">
          <p className="models-muted">{loginState.message}</p>
          <div className="models-auth-options">
            {loginState.options.map((option) => (
              <ConfigButton
                key={option.id}
                className="models-auth-option"
                onClick={() => void postLoginInput(loginState.token, option.id, t("models.loginContinuing"))}
              >
                {option.label}
              </ConfigButton>
            ))}
          </div>
        </div>
      )}
      {(loginState.phase === "auth" || loginState.phase === "prompt") && (
        <div className="models-auth-flow">
          <p className="models-muted">
            {loginState.phase === "auth" ? t("models.oauthPasteRedirect") : loginState.message}
          </p>
          {loginState.phase === "auth" && (
            <p className="models-hint">
              {t("models.oauthBrowserNotOpened")}{" "}
              <a href={loginState.url} target="_blank" rel="noopener noreferrer" className="models-link">
                {t("models.oauthOpenLoginPage")}
              </a>
            </p>
          )}
          <div className="models-inline-form">
            <input
              ref={inputRef}
              className="models-input is-mono"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitCode(loginState.token, inputValue); }}
              placeholder={loginState.phase === "auth" ? "http://localhost:1455/auth/callback?code=…" : (loginState.placeholder ?? t("models.enterValue"))}
            />
            <ConfigButton variant="primary" size="small" onClick={() => submitCode(loginState.token, inputValue)} disabled={!inputValue.trim()}>
              {t("i18n.submit")}
            </ConfigButton>
          </div>
        </div>
      )}
      {loginState.phase === "device_code" && (
        <div className="models-auth-flow">
          <p className="models-muted">{t("models.deviceCodeHint")}</p>
          <div className="models-device-code">{loginState.userCode}</div>
          <p className="models-hint">
            <a href={loginState.verificationUri} target="_blank" rel="noopener noreferrer" className="models-link">
              {loginState.verificationUri}
            </a>
            {loginState.expiresInSeconds ? ` · ${t("models.deviceCodeExpires", { minutes: Math.ceil(loginState.expiresInSeconds / 60) })}` : ""}
          </p>
        </div>
      )}
      {loginState.phase === "progress" && <p className="models-muted">{loginState.message}</p>}
      {loginState.phase === "success" && <Notice tone="success">{t("i18n.connectedSuccessfully")}</Notice>}
      {loginState.phase === "error" && <Notice tone="danger">{loginState.message}</Notice>}
    </div>
  );
}

// ── API key ───────────────────────────────────────────────────────────────────

export function ApiKeyDetail({ provider, onRefresh, cwd }: {
  provider: ApiKeyProvider;
  onRefresh: () => void;
  cwd: string | null;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const { t } = useI18n();

  // Reset state when provider changes
  useEffect(() => {
    setApiKey("");
    setError(null);
    setSavedOk(false);
  }, [provider.id]);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim(), cwd }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? `HTTP ${res.status}`);
      } else {
        setApiKey("");
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 2000);
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey, provider.id, onRefresh, cwd]);

  const handleRemove = useCallback(async () => {
    if (!confirmProviderDisconnect(t, provider.displayName)) return;
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) setError(d.error ?? `HTTP ${res.status}`);
      else onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(false);
    }
  }, [provider.id, provider.displayName, onRefresh, t, cwd]);

  return (
    <div className="models-auth">
      <div className="models-auth-row">
        <div className="models-auth-copy">
          <strong>{t("models.apiKeyTitle")}</strong>
          <StatusPill tone={provider.configured ? "success" : "muted"}>
            {provider.configured ? t("i18n.configured") : t("i18n.notConfigured")}
          </StatusPill>
        </div>
        {provider.configured && (
          <div className="models-auth-actions">
            <ConfigButton size="small" variant="ghost" className="models-danger-ghost" onClick={handleRemove} disabled={removing}>
              {removing ? t("i18n.removing") : t("i18n.disconnect")}
            </ConfigButton>
          </div>
        )}
      </div>

      <div className="models-inline-form">
        <SecretTextInput
          value={apiKey}
          onChange={setApiKey}
          onKeyDown={(e) => { if (e.key === "Enter" && apiKey.trim()) void handleSave(); }}
          placeholder={provider.configured ? t("models.replaceKeyPlaceholder") : "sk-…"}
          mono
        />
        <ConfigButton
          variant="primary"
          size="small"
          onClick={handleSave}
          disabled={saving || !apiKey.trim() || savedOk}
          className={savedOk ? "is-success" : undefined}
        >
          {savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : provider.configured ? t("models.updateKey") : t("models.saveKey")}
        </ConfigButton>
      </div>
      <p className="models-hint">{t("models.apiKeyStoredHint")}</p>

      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
