"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
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

  useEffect(() => {
    setDraft(page.url);
    setInvalid(false);
  }, [page]);

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
