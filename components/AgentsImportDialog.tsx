"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { ImportSource } from "@/lib/subagent-route";
import type { ImportableAgentFile, ImportScope } from "@/lib/subagents";
import { ConfigButton, SettingsLoading } from "./SettingsUi";

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

async function fetchJson<T extends { error?: string }>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const data = await response.json() as T;
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

/**
 * Copy agent definition files from another project (one with session history) into global or
 * this project. Files are imported byte-for-byte on the server, so hand-written frontmatter survives.
 */
export function AgentsImportDialog({ cwd, fixedScope, onClose, onImported }: {
  cwd: string;
  /** The Project page imports into this project only; the Agents page lets the user choose. */
  fixedScope?: ImportScope;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [sourceDir, setSourceDir] = useState<string | null>(null);
  const [items, setItems] = useState<ImportableAgentFile[] | null>(null);
  const [chosenScope, setScope] = useState<ImportScope>("global");
  const scope = fixedScope ?? chosenScope;
  // The user's own checks; untouched rows follow the default (a disable stub hides the inherited
  // definition, so it is never pre-checked).
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  useEffect(() => {
    fetchJson<{ sources: ImportSource[]; error?: string }>(`/api/subagents/profiles/import?cwd=${encodeURIComponent(cwd)}`)
      .then((data) => {
        setSources(data.sources);
        setSourceDir(data.sources[0]?.dir ?? null);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [cwd]);

  useEffect(() => {
    if (!sourceDir) return;
    let stale = false;
    setItems(null);
    setChosen(new Map());
    fetchJson<{ items: ImportableAgentFile[]; error?: string }>(
      `/api/subagents/profiles/import?cwd=${encodeURIComponent(cwd)}&sourceDir=${encodeURIComponent(sourceDir)}`,
    )
      .then((data) => { if (!stale) setItems(data.items); })
      .catch((cause) => { if (!stale) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { stale = true; };
  }, [cwd, sourceDir]);

  const available = (item: ImportableAgentFile) => !item.error && !item.existsIn[scope];
  const checked = (item: ImportableAgentFile) => available(item) && (chosen.get(item.file) ?? !item.disableStub);
  const picked = (items ?? []).filter(checked).map((item) => item.file);

  const runImport = async () => {
    if (!sourceDir || picked.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const data = await fetchJson<{ result: { imported: string[]; skipped: unknown[] }; error?: string }>(
        "/api/subagents/profiles/import",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, sourceDir, scope, files: picked }),
        },
      );
      setResult({ imported: data.result.imported.length, skipped: data.result.skipped.length });
      onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  if (!portalTarget) return null;

  return createPortal(
    <div
      className="models-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("agents.importTitle")}
      onClick={(event) => {
        if (event.target === event.currentTarget && !importing) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !importing) onClose();
      }}
    >
      <div className="models-dialog agents-import-dialog">
        <div className="models-dialog-header">
          <strong>{t("agents.importTitle")}</strong>
        </div>
        <div className="models-dialog-body agents-import-body">
          {result ? (
            <p className="settings-row-message is-success" role="status">
              {t("agents.importDone", { count: result.imported })}
              {result.skipped > 0 && <> · {t("agents.importSkipped", { count: result.skipped })}</>}
            </p>
          ) : sources && sources.length === 0 ? (
            <p className="settings-row-message">{t("agents.importNoSources")}</p>
          ) : sources === null ? (
            !error && <SettingsLoading label={t("i18n.loading")} />
          ) : (
            <>
              <label className="agents-import-scope">
                <span>{t("agents.importSource")}</span>
                <select
                  aria-label={t("agents.importSource")}
                  value={sourceDir ?? ""}
                  disabled={importing}
                  onChange={(event) => setSourceDir(event.target.value)}
                >
                  {sources.map((source) => (
                    // The project name leads (a native select clips the tail); a shared name falls back to the path.
                    <option key={source.dir} value={source.dir} title={source.dir}>
                      {sources.some((other) => other !== source && other.name === source.name) ? shortenPath(source.dir) : source.name} ({source.count})
                    </option>
                  ))}
                </select>
              </label>
              {!fixedScope && (
                <label className="agents-import-scope">
                  <span>{t("agents.saveLocation")}</span>
                  <select
                    aria-label={t("agents.saveLocation")}
                    value={scope}
                    disabled={importing}
                    onChange={(event) => setScope(event.target.value as ImportScope)}
                  >
                    <option value="global">{t("agents.saveLocation.global")}</option>
                    <option value="project">{t("agents.saveLocation.project")}</option>
                  </select>
                </label>
              )}
              <div className="agents-import-list">
                {items === null ? (
                  <SettingsLoading label={t("i18n.loading")} />
                ) : items.map((item) => {
                  const exists = item.existsIn[scope];
                  return (
                    <label key={item.file} className={`settings-checkbox agents-import-row${available(item) ? "" : " is-unavailable"}`} title={item.error ?? item.file}>
                      <input
                        type="checkbox"
                        checked={checked(item)}
                        disabled={importing || !available(item)}
                        onChange={(event) => setChosen((current) => new Map(current).set(item.file, event.target.checked))}
                      />
                      <span className="agents-import-copy">
                        <span className="agents-import-name">
                          {item.displayName}
                          {exists && <span className="settings-row-tag">{t("agents.importConflict")}</span>}
                          {item.error && <span className="settings-row-tag">{t("agents.importInvalid")}</span>}
                          {item.disableStub && !item.error && <span className="settings-row-tag">{t("agents.importStub")}</span>}
                        </span>
                        <span className="agents-import-description">{item.error ?? item.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
          {error && <p role="alert" className="settings-row-message is-error">{error}</p>}
        </div>
        <div className="models-dialog-footer agents-import-footer">
          <ConfigButton variant="ghost" onClick={onClose} disabled={importing}>
            {result ? t("agents.importClose") : sources?.length === 0 ? t("i18n.close") : t("i18n.cancel")}
          </ConfigButton>
          {!result && sources && sources.length > 0 && (
            <ConfigButton variant="primary" onClick={() => void runImport()} disabled={importing || picked.length === 0}>
              {importing ? t("agents.importing") : t("agents.importButton", { count: picked.length })}
            </ConfigButton>
          )}
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
