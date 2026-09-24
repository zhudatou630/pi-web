"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AppUpdateResponse } from "@/lib/api-types";

export function AppUpdateNotice({ showCurrentVersion = false }: { showCurrentVersion?: boolean }) {
  const { t } = useI18n();
  const [update, setUpdate] = useState<AppUpdateResponse | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [status, setStatus] = useState<"idle" | "requesting" | "waiting" | "timeout">("idle");
  const [error, setError] = useState<string | null>(null);
  const requesting = useRef(false);

  useEffect(() => {
    if (status !== "waiting" || !update) return;
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
          if (!stopped && result.currentVersion && result.currentVersion !== update.currentVersion) {
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
  }, [status, update]);

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

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/app-update", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<AppUpdateResponse>;
      })
      .then((result) => {
        setUpdate(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setCheckFailed(true);
      });
    return () => controller.abort();
  }, []);

  const available = update?.updateAvailable && update.latestVersion && update.releaseUrl;
  if (!showCurrentVersion && !available) return null;
  const accessibleLabel = t("appUpdate.releaseNotes", { version: update?.latestVersion ?? "" });

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: showCurrentVersion ? "flex-start" : "center", gap: 6 }}>
      {showCurrentVersion && (
        <>
          <p style={{ fontSize: 12 }}>{t("appUpdate.currentVersion", { version: update?.currentVersion ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "dev" })}</p>
          {!available && (
            <p role="status" style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {t(checkFailed ? "appUpdate.checkFailed" : !update ? "appUpdate.checking" : !update.releaseUrl ? "appUpdate.checkDisabled" : "appUpdate.upToDate")}
            </p>
          )}
        </>
      )}
      {available && update && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <a
            href={update.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={accessibleLabel}
            aria-label={accessibleLabel}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              alignSelf: "center",
              gap: 3,
              minHeight: 32,
              minWidth: 0,
              padding: "0 4px",
              background: "transparent",
              borderRadius: 4,
              color: "var(--accent)",
              fontSize: 12,
              fontWeight: 600,
              lineHeight: 1.2,
              textDecoration: "none",
              transition: "background 0.12s",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>v{update.latestVersion}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
              <path d="M7 17 17 7" />
              <path d="M7 7h10v10" />
            </svg>
          </a>
          {update.canUpdate && (
            <button
              type="button"
              disabled={status !== "idle"}
              onClick={() => { void startUpdate(); }}
              style={{ color: "var(--accent)", fontSize: 12, cursor: status === "idle" ? "pointer" : "default" }}
            >
              {t("appUpdate.updateAndRestart")}
            </button>
          )}
        </div>
      )}
      {showCurrentVersion && available && !update?.canUpdate && (
        <p style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("appUpdate.manualUpdate")}</p>
      )}
      {(status === "requesting" || status === "waiting") && (
        <p role="status" style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("appUpdate.waiting")}</p>
      )}
      {error && <p role="alert" style={{ color: "var(--text-muted)", fontSize: 12 }}>{error}</p>}
      {status === "timeout" && (
        <div role="alert" style={{ color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>
          <p>{t("appUpdate.timeout")}</p>
          <code>npm install -g @calmabacus/pi-web@latest</code>
          <p>{t("appUpdate.thenStart")}</p>
          <code>pi-web</code>
        </div>
      )}
    </div>
  );
}

