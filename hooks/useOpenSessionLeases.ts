"use client";

import { pageDebugFetch } from "@/lib/page-debug";
import { useEffect } from "react";

const SESSION_LEASE_RENEW_INTERVAL_MS = 30_000;

/** Renew the idle countdown for every open chat tab, not only the focused pane. */
export function useOpenSessionLeases(sessionIds: readonly string[]): void {
  const sessionIdsKey = sessionIds.join(",");

  useEffect(() => {
    if (!sessionIdsKey) return;
    const ids = sessionIdsKey.split(",");
    let disposed = false;

    const renew = () => {
      if (disposed) return;
      for (const id of ids) {
        void pageDebugFetch("lease", `/api/agent/${encodeURIComponent(id)}/lease`, {
          method: "POST",
          cache: "no-store",
        }).catch(() => {});
      }
    };

    renew();
    const interval = setInterval(renew, SESSION_LEASE_RENEW_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") renew();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionIdsKey]);
}
