"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getPageDebugSnapshot } from "@/lib/page-debug";
import type { DebugSnapshot } from "@/lib/debug-types";

type Reading = { server: DebugSnapshot; client: ReturnType<typeof getPageDebugSnapshot>; at: number };

export function DebugPanel() {
  const { t } = useI18n();
  const [reading, setReading] = useState<Reading | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (stopped || controller || document.visibilityState !== "visible") return;
      controller = new AbortController();
      const current = controller;
      const timeout = setTimeout(() => current.abort(), 5_000);
      try {
        const response = await fetch("/api/agent/debug", { cache: "no-store", signal: current.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const server: DebugSnapshot = await response.json();
        if (!stopped && document.visibilityState === "visible") {
          setReading({ server, client: getPageDebugSnapshot(), at: Date.now() });
          setFailed(false);
        }
      } catch {
        if (!stopped && document.visibilityState === "visible") setFailed(true);
      } finally {
        clearTimeout(timeout);
        controller = null;
        if (!stopped && document.visibilityState === "visible") timer = setTimeout(() => void poll(), 2_500);
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") void poll();
      else controller?.abort();
    };
    void poll();
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  const row = (label: string, value: ReactNode) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
      <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: "right", overflowWrap: "anywhere", minWidth: 0 }}>{value}</span>
    </div>
  );
  const heading = (title: string) => <h3 style={{ fontSize: 12, fontWeight: 600, margin: "0 0 6px" }}>{title}</h3>;
  const sectionStyle = { borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 12 };
  const age = (at: number | null) => at && reading ? t("debug.secondsAgo", { n: Math.max(0, Math.floor((reading.at - at) / 1000)) }) : "—";

  return (
    <div className="popover-surface" style={{ maxHeight: "inherit", overflowY: "auto", overscrollBehavior: "contain", padding: "12px 14px", fontSize: 12, lineHeight: 1.5, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
      <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{t("debug.title")}</h2>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 12 }}>{t("debug.readOnly")}</div>
      {failed && <div role="status" style={{ color: "var(--danger)" }}>{t("debug.failed")}</div>}
      {!reading ? <div role="status">{t("debug.loading")}</div> : <>
        {heading(t("debug.page"))}
        {row(t("debug.pageId"), reading.client.id)}
        {reading.client.streams.map((stream, index) => <div key={index} style={{ marginTop: 8 }}>
          {row(`${t(`debug.${stream.kind}`)}${stream.resourceId ? ` · ${stream.resourceId.slice(0, 8)}` : ""}`, t(`debug.state${stream.state}`))}
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("debug.streamReading", { age: age(stream.lastDataAt), n: stream.reconnects })}</div>
        </div>)}
        {(["running", "lease"] as const).map((kind) => {
          const request = reading.client.requests[kind];
          return <div key={kind} style={{ marginTop: 6 }}>{row(t(`debug.${kind}Poll`), request
            ? t("debug.requestReading", { ms: request.ms, status: t(request.ok ? "debug.ok" : "debug.error"), n: request.failures, age: age(request.at) }) : "—")}</div>;
        })}
        <section style={sectionStyle}>
          {heading(t("debug.runtimes", { n: reading.server.sessions.length }))}
          {reading.server.sessions.map((session) => <div key={session.id} style={{ marginTop: 10 }}>
            <div title={session.id} style={{ overflowWrap: "anywhere" }}>{session.cwd ?? "—"} · {session.id}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{[
              t(session.alive ? "debug.alive" : "debug.notAlive"),
              session.starting && t("debug.starting"), session.closing && t("debug.closing"),
              t(session.running ? "debug.running" : "debug.idle"), session.compacting && t("debug.compacting"),
            ].filter(Boolean).join(" · ")}</div>
            {row(t("debug.listeners"), `${session.keepAliveListeners} / ${session.sseSubscribers}`)}
            {row(t(session.forcedIdle ? "debug.stopDeadline" : "debug.idleDeadline"), session.idleDeadline === null ? "—" : t("debug.seconds", { n: Math.max(0, Math.ceil((session.idleDeadline - reading.at) / 1000)) }))}
            {row(t("debug.pending"), `${session.pendingExtensionUi} / ${session.activeSubagentRuns}`)}
          </div>)}
        </section>
        <section style={sectionStyle}>
          {heading(t("debug.connections"))}
          {reading.server.pages.map((page) => <div key={page.pageId} style={{ marginTop: 8 }}>
            <div style={{ overflowWrap: "anywhere" }}>{page.pageId}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("debug.counts", { agent: page.counts.agent, terminal: page.counts.terminal, file: page.counts["file-watch"] })}</div>
          </div>)}
          <div style={{ marginTop: 8 }}>{row(t("debug.fileWatches"), reading.server.fileWatches)}</div>
          {row(t("debug.terminals"), reading.server.terminals.length)}
          {reading.server.terminals.map((terminal) => <div key={terminal.id} style={{ marginTop: 4 }}>{row(terminal.id, t("debug.terminalListeners", { n: terminal.listeners }))}</div>)}
        </section>
      </>}
    </div>
  );
}
