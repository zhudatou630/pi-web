"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatCompactRelativeTime } from "@/lib/i18n/format";
import { isImeComposing } from "@/lib/ime";
import { getSessionDisplayTitle } from "@/lib/session-display-title";
import type { SessionStatus } from "@/lib/session-status";
import type { SessionInfo } from "@/lib/types";
import { ModalDialog } from "./ModalDialog";
import { SessionSearch } from "./SessionSearch";
import { SessionStatusDot } from "./SessionStateBadge";

export interface RecentSession {
  session: SessionInfo;
  status: SessionStatus | null;
  /** Project name, shown before the time. */
  project: string;
}

/**
 * Cursor's search palette (docs/ui.md, Sidebar search): a field over recent sessions; typing
 * switches the list to full-text results. ↑/↓ walk the rows, Enter opens the focused one
 * (from the field, the first), Escape or a click outside closes.
 */
export function SessionSearchDialog({ recent, projectNames, archivedSessionIds, selectedSessionId, refreshKey, onSelectSession, onClose }: {
  recent: readonly RecentSession[];
  projectNames: ReadonlyMap<string, string>;
  archivedSessionIds: ReadonlySet<string>;
  selectedSessionId: string | null;
  refreshKey: number | null;
  onSelectSession: (session: SessionInfo, entryId?: string, blockIndex?: number) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent) => {
    // Candidate selection belongs to the input method: never move focus or open a row.
    if (isImeComposing(event)) return;
    const rows = [...(bodyRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      rows[0]?.click();
      return;
    }
    if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || !rows.length) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") (rows[index + 1] ?? rows[index] ?? rows[0]).focus();
    else if (index <= 0) inputRef.current?.focus();
    else rows[index - 1].focus();
  };

  return (
    <ModalDialog aria-label={t("sidebar.toggleSessionSearch")} className="session-search-backdrop" onClose={onClose} onKeyDown={onKeyDown}>
      <div className="session-search-dialog">
        <label className="session-search-input-row">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            autoFocus
            value={query}
            maxLength={200}
            aria-label={t("sidebar.searchSessions")}
            placeholder={t("sidebar.searchSessions")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div ref={bodyRef} className="session-search-body">
          <SessionSearch query={query} refreshKey={refreshKey} projectNames={projectNames} archivedSessionIds={archivedSessionIds}
            selectedSessionId={selectedSessionId} onSelectSession={onSelectSession}>
            {recent.length > 0 && (
              <>
                <div className="session-search-caption">{t("sidebar.groupRecent")}</div>
                {recent.map(({ session, status, project }) => (
                  <button key={session.id} type="button" className="session-search-row"
                    aria-current={session.id === selectedSessionId ? "true" : undefined}
                    onClick={() => onSelectSession(session)}>
                    {status ? <SessionStatusDot status={status} /> : <span className="session-status-dot" data-status="idle" aria-hidden="true" />}
                    <span className="session-search-row-title">{getSessionDisplayTitle(session)}</span>
                    <span className="session-search-row-meta">{project}</span>
                    <span className="session-search-row-meta">{formatCompactRelativeTime(session.modified, locale)}</span>
                  </button>
                ))}
              </>
            )}
          </SessionSearch>
        </div>
      </div>
    </ModalDialog>
  );
}
