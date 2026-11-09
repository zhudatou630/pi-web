"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { loadFrameHistory, observeFrameHistory, startFrameHistory, stepFrameHistory } from "@/lib/frame-history";
import { parsePreviewTarget, previewFrameUrl } from "@/lib/preview-target";
import type { DevServer } from "@/lib/dev-servers";

/** The browser tab's address; a new `id` reloads the frame even for the same URL. */
export interface BrowserState {
  url: string;
  id: number;
}

export const BROWSER_TAB_ID = "browser";

/** Shows a service of the Pi Web machine (`localhost:<port>`), directly or through the preview proxy. */
export function BrowserPanel({ page, cwd, onNavigate }: {
  page: BrowserState;
  /** Directory of the focused chat; its dev servers are listed first. */
  cwd: string | null;
  onNavigate: (url: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(page.url);
  const [invalid, setInvalid] = useState(false);
  const [proxyUrl, setProxyUrl] = useState<string | null | undefined>(undefined);
  const [frameHistory, setFrameHistory] = useState(() => startFrameHistory(window.history.length));
  const lengthAtLoad = useRef(0);
  // Steps taken by the buttons whose load has not finished yet; each excuses one load.
  const ownSteps = useRef({ count: 0, at: 0 });

  useEffect(() => {
    setDraft(page.url);
    setInvalid(false);
  }, [page]);

  // The frame is cross-origin: its navigations (SPA pushState too) show only as a longer top-level
  // history, polled because no event reaches this page. A new frame (`page.id`) starts at the current entry.
  useEffect(() => {
    setFrameHistory(startFrameHistory(window.history.length));
    lengthAtLoad.current = window.history.length;
    ownSteps.current = { count: 0, at: 0 };
    const timer = window.setInterval(() => setFrameHistory((state) => observeFrameHistory(state, window.history.length)), 500);
    return () => window.clearInterval(timer);
  }, [page.id]);

  // Back/Forward traverse the joint history, which steps the frame. The length is read first: a
  // navigation since the last poll would otherwise be counted after the step. If the inferred
  // position is still wrong, Back would leave Pi Web, so a leave prompt covers the next second
  // (not on iOS, which fires no beforeunload; `onFrameLoad` narrows that case).
  const go = (delta: -1 | 1) => {
    const observed = observeFrameHistory(frameHistory, window.history.length);
    const next = stepFrameHistory(observed, delta);
    setFrameHistory(next);
    if (next === observed) return;
    ownSteps.current = { count: ownSteps.current.count + 1, at: Date.now() };
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    window.setTimeout(() => window.removeEventListener("beforeunload", guard), 1000);
    window.history.go(delta);
  };

  const onFrameLoad = () => {
    const length = window.history.length;
    const previous = lengthAtLoad.current;
    // An SPA step loads nothing, so an unused excuse expires.
    const ownStep = ownSteps.current.count > 0 && Date.now() - ownSteps.current.at < 3000;
    if (ownStep) ownSteps.current.count -= 1;
    lengthAtLoad.current = length;
    setFrameHistory((state) => loadFrameHistory(state, length, previous, ownStep));
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/preview")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { proxyUrl?: unknown } | null) => { if (!cancelled) setProxyUrl(typeof body?.proxyUrl === "string" ? body.proxyUrl : null); })
      .catch(() => { if (!cancelled) setProxyUrl(null); });
    return () => { cancelled = true; };
  }, []);

  const target = parsePreviewTarget(page.url);
  const frameUrl = target ? previewFrameUrl(target, window.location.hostname, proxyUrl ?? null) : null;
  // Chrome keeps a frame's stylesheets and scripts in memory for the whole Pi Web tab, past any cache
  // clearing, so the cache-free load (proxy drops the preview's cached files) happens in a new window.
  const windowUrl = target ? previewFrameUrl(target, window.location.hostname, proxyUrl ?? null, true) : null;
  const message = !frameUrl && proxyUrl !== undefined ? t("browser.remoteOff") : null;

  return (
    <div className="browser-panel">
      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          // An empty address goes back to the list of local servers.
          if (!draft.trim()) { setInvalid(false); onNavigate(""); return; }
          const next = parsePreviewTarget(draft);
          setInvalid(!next);
          if (next) onNavigate(next.href);
        }}
      >
        <input
          type="text"
          inputMode="url"
          value={draft}
          onChange={(event) => { setDraft(event.target.value); setInvalid(false); }}
          placeholder={t("browser.placeholder")}
          aria-label={t("browser.address")}
          aria-invalid={invalid || undefined}
          autoFocus={!page.url}
          enterKeyHint="go"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="button" className="file-viewer-icon-button" onClick={() => go(-1)} disabled={!frameUrl || !frameHistory.back} title={t("browser.back")} aria-label={t("browser.back")}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <button type="button" className="file-viewer-icon-button" onClick={() => go(1)} disabled={!frameUrl || !frameHistory.forward} title={t("browser.forward")} aria-label={t("browser.forward")}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        </button>
        <button type="button" className="file-viewer-icon-button" onClick={() => onNavigate(page.url)} disabled={!frameUrl} title={t("browser.reload")} aria-label={t("browser.reload")}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>
        </button>
        <button type="button" className="file-viewer-icon-button" onClick={() => { if (windowUrl) window.open(windowUrl, "_blank", "noopener"); }} disabled={!frameUrl} title={t("browser.openInNewWindow")} aria-label={t("browser.openInNewWindow")}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
        </button>
      </form>
      {invalid && <div className="browser-hint" role="alert">{t("browser.localOnly")}</div>}
      {frameUrl ? (
        <iframe
          key={page.id}
          className="browser-frame"
          onLoad={onFrameLoad}
          src={frameUrl}
          title={page.url}
          // No allow-top-navigation: the previewed page cannot navigate Pi Web away.
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
          allow="clipboard-write; fullscreen"
        />
      ) : !target ? (
        // Keyed by directory: switching chats drops the other directory's results.
        <DevServerList key={cwd ?? ""} cwd={cwd} onOpen={onNavigate} />
      ) : (
        <div className="browser-message">{message}</div>
      )}
    </div>
  );
}

/** Empty-tab content: on request, local HTTP services, the focused chat directory's first, the rest folded. */
function DevServerList({ cwd, onOpen }: { cwd: string | null; onOpen: (url: string) => void }) {
  const { t } = useI18n();
  const [servers, setServers] = useState<DevServer[] | null>(null);
  const [detecting, setDetecting] = useState(false);

  const detect = () => {
    setDetecting(true);
    fetch(`/api/preview/servers${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { servers?: DevServer[] } | null) => setServers(body?.servers ?? []))
      .catch(() => setServers([]))
      .finally(() => setDetecting(false));
  };

  if (servers === null) {
    return (
      <div className="browser-message browser-servers-start">
        <p>{t("browser.empty")}</p>
        <button type="button" className="browser-servers-detect" onClick={detect} disabled={detecting}>
          {detecting ? t("browser.detecting") : t("browser.detect")}
        </button>
      </div>
    );
  }

  const own = servers?.filter((server) => server.inCwd) ?? [];
  const others = servers?.filter((server) => !server.inCwd) ?? [];
  const row = (server: DevServer) => (
    <button key={server.url} type="button" className="browser-server" onClick={() => onOpen(server.url)} title={server.cwd ?? server.url}>
      <span className="browser-server-port">{server.port}</span>
      <span className="browser-server-detail">{[server.process, server.cwd].filter(Boolean).join(" · ")}</span>
    </button>
  );

  return (
    <div className="browser-servers">
      <div className="browser-servers-head">
        <span>{own.length ? t("browser.serversHere") : t("browser.noServersHere")}</span>
        <button type="button" className="browser-servers-refresh" onClick={detect} disabled={detecting}>{detecting ? t("browser.detecting") : t("browser.refresh")}</button>
      </div>
      {own.map(row)}
      {others.length > 0 && (
        <details className="browser-servers-others" open={!own.length}>
          <summary>{t("browser.otherServers", { count: others.length })}</summary>
          {others.map(row)}
        </details>
      )}
    </div>
  );
}
