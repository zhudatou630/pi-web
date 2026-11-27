"use client";

import { useMemo } from "react";
import { unnamedSideChatNumbers } from "@/lib/session-family";
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

// Running is the sidebar's gray breathing dot with a dim word: blue means unread (docs/ui.md, Session state).
function statusColor(status: SubagentSessionStatus): string {
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
  // Completed rows show no status.
  return null;
}

function AgentRow({
  session,
  displayTitle,
  main,
  selected,
  running,
  onSelect,
  onOpenInNewTab,
  actionSlot,
  onDelete,
}: {
  session: SessionInfo;
  displayTitle?: string;
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
  const sidePrefix = t("session.sideNamePrefix");
  const title = displayTitle ?? sessionTitle(session);
  // The row icon already says "side chat"; the name's prefix only crowds out the question.
  const primary = main
    ? t("agentSwitcher.main")
    : relation?.description || (side && title.startsWith(sidePrefix) ? title.slice(sidePrefix.length) : title);
  const time = formatCompactRelativeTime(session.modified, locale);
  const secondary = main
    ? title
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
        {/* Completed is the resting state of every row (and all a chat can be when idle): only other states are shown. */}
        {status !== "completed" && (
          <span style={{ display: "flex", alignItems: "center", gap: 6, color: statusColor(status) }}>
            <StatusIcon status={status} />
            <span>{t(`agentSwitcher.status.${status}`)}</span>
          </span>
        )}
        {/* With side chats the check moves to the row's trailing slot, shared with Delete. */}
        {!actionSlot && <MenuCheck checked={selected} />}
      </span>
    </button>
  );
  if (!actionSlot) return row;
  return (
    <div className="menu-surface-row agent-row-with-action">
      {row}
      <span className="menu-check-slot">
        <MenuCheck checked={selected} />
        {onDelete && (
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
        )}
      </span>
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
  const sideNumbers = useMemo(() => unnamedSideChatNumbers(subagents), [subagents]);
  const sortedSubagents = useMemo(() => [...subagents].sort((a, b) => {
    const rank = statusPriority(sessionStatus(a, runningSessionIds.has(a.id)))
      - statusPriority(sessionStatus(b, runningSessionIds.has(b.id)));
    if (rank !== 0) return rank;
    return b.modified.localeCompare(a.modified);
  }), [runningSessionIds, subagents]);
  const actionSlot = Boolean(onDeleteSideChat) && subagents.some((session) => session.relation?.kind === "side");

  return (
    <div
      role="listbox"
      aria-label={t("agentSwitcher.title")}
      className="popover-surface"
      style={{ overflow: "hidden" }}
    >
      <div>
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
          {sortedSubagents.map((session) => (
            <AgentRow
              key={session.id}
              session={session}
              displayTitle={sideNumbers.has(session.id) ? t("chat.unnamedSideChat", { number: sideNumbers.get(session.id)! }) : undefined}
              selected={session.id === selectedSessionId}
              running={runningSessionIds.has(session.id)}
              onSelect={() => onSelectSession(session)}
              onOpenInNewTab={onOpenInNewTab ? () => onOpenInNewTab(session) : undefined}
              actionSlot={actionSlot}
              onDelete={onDeleteSideChat && session.relation?.kind === "side" ? () => onDeleteSideChat(session) : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
