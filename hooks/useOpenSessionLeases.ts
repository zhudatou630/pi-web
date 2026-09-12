"use client";

import { useEffect } from "react";

const SESSION_LEASE_RENEW_INTERVAL_MS = 30_000;

/** Heartbeat for every mounted session ChatWindow. Closed tabs expire after the 90s TTL. */
export function useOpenSessionLeases(sessionIds: readonly string[]): void {
  const sessionIdsKey = sessionIds.join(",");

  useEffect(() => {
    if (!sessionIdsKey) return;
    const ids = sessionIdsKey.split(",");
    let disposed = false;

    const renew = () => {
      if (disposed) return;
      for (const id of ids) {
        void fetch(`/api/agent/${encodeURIComponent(id)}/lease`, {
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
