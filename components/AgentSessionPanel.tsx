"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatCompactRelativeTime } from "@/lib/i18n/format";
import type { SessionInfo, SubagentSessionStatus } from "@/lib/types";
import { LivePulseBeacon } from "./LivePulseBeacon";
import { SubagentIcon } from "./SubagentIcon";
import { MenuCheck } from "./MenuCheck";
import { iconStroke } from "./iconStroke";

interface Props {
  rootSession: SessionInfo;
  subagents: SessionInfo[];
  selectedSessionId: string;
  runningSessionIds: ReadonlySet<string>;
  onSelectSession: (session: SessionInfo) => void;
  onOpenInNewTab?: (session: SessionInfo) => void;
  /** Deletes one side chat (the main session and its other members stay). */
  onDeleteSideChat?: (session: SessionInfo) => void;
}

function sessionTitle(session: SessionInfo): string {
  return session.name || session.firstMessage || session.id.slice(0, 12);
}

/** Most subagents use the default profile; naming it on every row only crowds out the model. */
const DEFAULT_SUBAGENT_PROFILE = "general-purpose";

function statusColor(status: SubagentSessionStatus): string {
  if (status === "running" || status === "starting") return "var(--accent)";
  if (status === "completed") return "var(--success)";
  if (status === "failed") return "var(--danger)";
  if (status === "aborted") return "var(--warning)";
  return "var(--text-dim)";
}

function sessionStatus(session: SessionInfo, running: boolean): SubagentSessionStatus {
  return running
    ? "running"
    : session.relation?.kind === "subagent"
      ? session.relation.status
      : "completed";
}

function statusPriority(status: SubagentSessionStatus): number {
  if (status === "running" || status === "starting") return 0;
  if (status === "queued") return 1;
  return 2;
}

function StatusIcon({ status }: { status: SubagentSessionStatus }) {
  if (status === "running" || status === "starting") {
    return <LivePulseBeacon size={13} />;
  }
  if (status === "failed") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" />
      </svg>
    );
  }
  if (status === "queued") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
      </svg>
    );
  }
  if (status === "aborted" || status === "interrupted") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M9 9h6v6H9z" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" />
    </svg>
  );
}

function AgentRow({
  session,
  main,
  selected,
  running,
  onSelect,
  onOpenInNewTab,
  actionSlot,
  onDelete,
}: {
  session: SessionInfo;
  main?: boolean;
  selected: boolean;
  running: boolean;
  onSelect: () => void;
  onOpenInNewTab?: () => void;
  /** Keeps the trailing action column, so checks line up with rows that have Delete. */
  actionSlot?: boolean;
  onDelete?: () => void;
}) {
  const { locale, t } = useI18n();
  const relation = session.relation?.kind === "subagent" ? session.relation : null;
  const side = session.relation?.kind === "side";
  const status = sessionStatus(session, running);
  const primary = main ? t("agentSwitcher.main") : relation?.description || sessionTitle(session);
  const time = formatCompactRelativeTime(session.modified, locale);
  const secondary = main
    ? sessionTitle(session)
    : relation
      ? [relation.profile !== DEFAULT_SUBAGENT_PROFILE && relation.profile, relation.model?.id, relation.thinkingLevel, time].filter(Boolean).join(" · ")
      : side ? time : `${t("agentSwitcher.subagent")} · ${time}`;
  const secondaryTitle = relation
    ? [relation.profile, relation.model && `${relation.model.provider}/${relation.model.id}`, relation.thinkingLevel, session.modified].filter(Boolean).join(" · ")
    : secondary;

  const row = (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onAuxClick={(event) => {
        if (event.button === 1 && onOpenInNewTab) {
          event.preventDefault();
          onOpenInNewTab();
        }
      }}
      className="agent-row"
    >
      <span style={{ display: "grid", placeItems: "center" }}>
        {main ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={iconStroke(14)} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18" />
          </svg>
        ) : side ? (
          // The selection toolbar's Side chat glyph.
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={iconStroke(14)} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3v12M18 9a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
          </svg>
        ) : (
          <SubagentIcon size={14} />
        )}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }} title={primary}>
          {primary}
        </span>
        <span style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 11 }} title={secondaryTitle}>
          {secondary}
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, whiteSpace: "nowrap" }}>
        {/* A main or side chat shows a status only while it runs; "completed" means nothing for a chat. */}
        {!((main || side) && !running) && (
          <span style={{ display: "flex", alignItems: "center", gap: 6, color: statusColor(status) }}>
            <StatusIcon status={status} />
            <span>{t(`agentSwitcher.status.${status}`)}</span>
          </span>
        )}
        <MenuCheck checked={selected} />
      </span>
    </button>
  );
  if (!actionSlot) return row;
  return (
    <div className="menu-surface-row agent-row-with-action">
      {row}
      {onDelete ? (
        <button
          type="button"
          className="menu-surface-row-action is-danger"
          onClick={onDelete}
          title={t("agentSwitcher.deleteSideChat")}
          aria-label={`${t("agentSwitcher.deleteSideChat")}: ${primary}`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={iconStroke(13)} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
      ) : <span className="menu-surface-row-action" aria-hidden="true" />}
    </div>
  );
}

export function AgentSessionPanel({
  rootSession,
  subagents,
  selectedSessionId,
  runningSessionIds,
  onSelectSession,
  onOpenInNewTab,
  onDeleteSideChat,
}: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const sortedSubagents = useMemo(() => [...subagents].sort((a, b) => {
    const rank = statusPriority(sessionStatus(a, runningSessionIds.has(a.id)))
      - statusPriority(sessionStatus(b, runningSessionIds.has(b.id)));
    if (rank !== 0) return rank;
    return b.modified.localeCompare(a.modified);
  }), [runningSessionIds, subagents]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSubagents = normalizedQuery
    ? sortedSubagents.filter((session) => {
        const relation = session.relation?.kind === "subagent" ? session.relation : null;
        return [relation?.description, relation?.profile, session.name, session.firstMessage]
          .some((value) => value?.toLowerCase().includes(normalizedQuery));
      })
    : sortedSubagents;
  const runningCount = subagents.filter((session) => runningSessionIds.has(session.id)).length;
  const actionSlot = Boolean(onDeleteSideChat) && subagents.some((session) => session.relation?.kind === "side");

  return (
    <div
      role="listbox"
      aria-label={t("agentSwitcher.title")}
      className="popover-surface"
      style={{ overflow: "hidden" }}
    >
      <div>
        <div style={{ minHeight: 40, display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ fontSize: 12, fontWeight: 600 }}>{t("agentSwitcher.title")}</strong>
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
            {t("agentSwitcher.count", { count: subagents.length })}
          </span>
          {runningCount > 0 && (
            <span style={{ marginLeft: "auto", color: "var(--accent)", fontSize: 11 }}>
              {t("agentSwitcher.runningCount", { count: runningCount })}
            </span>
          )}
        </div>
        {subagents.length > 8 && (
          <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
            <input
              type="search"
              className="agent-switcher-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("agentSwitcher.search")}
              aria-label={t("agentSwitcher.search")}
              style={{
                width: "100%", height: "var(--ui-row-height)", padding: "0 10px",
                border: "none", borderRadius: 6,
                background: "var(--ui-field-bg)", boxShadow: "var(--ui-field-edge)", color: "var(--text)", fontSize: 12, outline: "none",
              }}
            />
          </div>
        )}
        <div style={{ maxHeight: "min(58dvh, 480px)", overflowY: "auto", padding: 4 }}>
          <AgentRow
            session={rootSession}
            main
            selected={rootSession.id === selectedSessionId}
            running={runningSessionIds.has(rootSession.id)}
            onSelect={() => onSelectSession(rootSession)}
            onOpenInNewTab={onOpenInNewTab ? () => onOpenInNewTab(rootSession) : undefined}
            actionSlot={actionSlot}
          />
          {visibleSubagents.map((session) => (
            <AgentRow
              key={session.id}
              session={session}
              selected={session.id === selectedSessionId}
              running={runningSessionIds.has(session.id)}
              onSelect={() => onSelectSession(session)}
              onOpenInNewTab={onOpenInNewTab ? () => onOpenInNewTab(session) : undefined}
              actionSlot={actionSlot}
              onDelete={onDeleteSideChat && session.relation?.kind === "side" ? () => onDeleteSideChat(session) : undefined}
            />
          ))}
          {visibleSubagents.length === 0 && (
            <div style={{ padding: "22px 12px", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
              {t("agentSwitcher.noMatches")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
