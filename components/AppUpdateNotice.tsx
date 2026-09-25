"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AppUpdateResponse } from "@/lib/api-types";
import { SettingsRow } from "./SettingsUi";

export function AppUpdateNotice({ showCurrentVersion = false }: { showCurrentVersion?: boolean }) {
  const { t } = useI18n();
  const [update, setUpdate] = useState<AppUpdateResponse | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [manualChecking, setManualChecking] = useState(false);
  const [status, setStatus] = useState<"idle" | "requesting" | "waiting" | "timeout">("idle");
  const [error, setError] = useState<string | null>(null);
  const requesting = useRef(false);
  const currentVersion = update?.currentVersion;

  useEffect(() => {
    if (status !== "waiting" || !currentVersion) return;
    const controller = new AbortController();
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout>;
    const deadline = setTimeout(() => {
      stopped = true;
      controller.abort();
      clearTimeout(pollTimer);
      setStatus("timeout");
    }, 180_000);
    const poll = async () => {
      try {
        const response = await fetch("/api/app-update?status=1", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.ok) {
          const result = await response.json() as AppUpdateResponse;
          if (!stopped && result.currentVersion && result.currentVersion !== currentVersion) {
            stopped = true;
            clearTimeout(deadline);
            window.location.reload();
            return;
          }
        }
      } catch {
        // The server is expected to be unavailable while restarting.
      }
      if (!stopped) pollTimer = setTimeout(() => { void poll(); }, 2000);
    };
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(deadline);
      clearTimeout(pollTimer);
    };
  }, [status, currentVersion]);

  const startUpdate = async () => {
    if (requesting.current || !window.confirm(t("appUpdate.confirm"))) return;
    requesting.current = true;
    setError(null);
    setStatus("requesting");
    try {
      const response = await fetch("/api/app-update", { method: "POST" });
      if (response.status !== 202) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error || t("appUpdate.failed"));
      }
      setStatus("waiting");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("appUpdate.failed"));
      setStatus("idle");
      requesting.current = false;
    }
  };

  const checkForUpdate = useCallback(async (force: boolean, signal?: AbortSignal) => {
    try {
      const response = await fetch(force ? "/api/app-update?force=1" : "/api/app-update", { cache: "no-store", signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setUpdate(await response.json() as AppUpdateResponse);
      setCheckFailed(false);
    } catch {
      if (!signal?.aborted) setCheckFailed(true);
    }
  }, []);

  // Long-lived tabs re-check when shown again; the server cache keeps this cheap.
  useEffect(() => {
    const controller = new AbortController();
    void checkForUpdate(false, controller.signal);
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkForUpdate(false, controller.signal);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkForUpdate]);

  const checkNow = async () => {
    setManualChecking(true);
    setCheckFailed(false);
    await checkForUpdate(true);
    setManualChecking(false);
  };

  const available = update?.updateAvailable && update.latestVersion && update.releaseUrl;
  if (!showCurrentVersion && !available) return null;
  const accessibleLabel = t("appUpdate.releaseNotes", { version: update?.latestVersion ?? "" });
  const updateLabel = t("appUpdate.updateAndRestart");

  const releaseLink = available && update ? (
    <a className="app-update-link" href={update.releaseUrl} target="_blank" rel="noopener noreferrer" title={accessibleLabel} aria-label={accessibleLabel}>
      v{update.latestVersion}
    </a>
  ) : null;
  const updating = status === "requesting" || status === "waiting";
  const updateButton = available && update?.canUpdate ? (
    <button type="button" className="app-update-action" disabled={status !== "idle"} title={updating ? t("appUpdate.waiting") : updateLabel} aria-label={updating ? t("appUpdate.waiting") : updateLabel} onClick={() => { void startUpdate(); }}>
      {t(updating ? "appUpdate.updating" : "appUpdate.update")}
    </button>
  ) : null;
  const refresh = (checkFailed || update?.releaseUrl) ? (
    <button
      type="button"
      className="app-update-icon"
      disabled={manualChecking || status !== "idle"}
      onClick={() => { void checkNow(); }}
      title={t("appUpdate.checkNow")}
      aria-label={t("appUpdate.checkNow")}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
    </button>
  ) : null;

  const showDetail = (showCurrentVersion && available && !update?.canUpdate) || !!error || status === "timeout";
  const detailPanel = showDetail ? (
    <div className="app-update-detail popover-surface">
      {showCurrentVersion && available && !update?.canUpdate && (
        update?.manualCommand ? (
          <p>{t("appUpdate.manualCommand")} <code>{update.manualCommand}</code></p>
        ) : (
          <p>{t("appUpdate.manualUpdate")}</p>
        )
      )}
      {error && <p role="alert">{error}</p>}
      {status === "timeout" && (
        <div role="alert">
          <p>{t("appUpdate.timeout")}</p>
          <p><code>npm install -g @calmabacus/pi-web@latest</code></p>
          <p>{t("appUpdate.thenStart")} <code>pi-web</code></p>
        </div>
      )}
    </div>
  ) : null;

  if (!showCurrentVersion) {
    return (
      <>
        <div className="app-update-home">
          {releaseLink}
          {updateButton}
        </div>
        {detailPanel}
      </>
    );
  }

  const statusText = t(manualChecking || (!update && !checkFailed) ? "appUpdate.checking" : checkFailed ? "appUpdate.checkFailed" : !update?.releaseUrl ? "appUpdate.checkDisabled" : "appUpdate.upToDate");
  return (
    <>
      <SettingsRow label={t("settings.version")}>
        <span className="app-update-line">
          <span className="app-update-current">{t("appUpdate.currentVersion", { version: update?.currentVersion ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "dev" })}</span>
          {available ? (
            <>
              <span aria-hidden="true">→</span>
              {releaseLink}
              {updateButton}
            </>
          ) : (
            <span role="status" className="app-update-status">{statusText}</span>
          )}
          {refresh}
          {detailPanel}
        </span>
      </SettingsRow>
    </>
  );
}

