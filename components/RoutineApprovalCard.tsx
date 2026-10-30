"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";
import { describeSchedule } from "@/lib/routine-summary";
import type { RoutineApprovalCard as CardData } from "@/lib/types";
import { CollapsibleQuote } from "./CollapsibleQuote";
import { ConfigButton } from "./SettingsUi";

/**
 * `create_routine` asking to save a routine: an inline card at the end of the chat (where the
 * tool call is), not a modal. One surface like the composer: a caption, the name, one line of
 * when/next/where, the instructions as a quoted passage, then the two actions.
 * Design: docs/routines.md ("Create from chat").
 */
export function RoutineApprovalCard({ card, onApprove, onDecline }: {
  card: CardData;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);

  const next = card.nextRunAt ? new Date(card.nextRunAt) : null;
  const facts = [
    describeSchedule(card.schedule, locale, t),
    next
      ? t("routines.approval.nextAt", {
        when: next.toLocaleString(locale, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h12", timeZone: card.timeZone }),
        relative: formatRelativeTime(next, locale as never),
      })
      : t("routines.schedule.neverRuns"),
    t(card.runIn === "this_chat" ? "routines.approval.thisChat" : "routines.mode.new_session"),
  ];
  const respond = (approve: boolean) => {
    setBusy(true);
    if (approve) onApprove();
    else onDecline();
  };

  return (
    <section
      className="routine-approval"
      aria-label={t("routines.approval.title", { name: card.name })}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        respond(false);
      }}
    >
      <div className="routine-approval-caption">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
        </svg>
        {t("routines.approval.caption")}
      </div>
      <h3 className="routine-approval-name">{card.name}</h3>
      <p className="routine-approval-facts">
        {facts.map((fact, index) => (
          <span key={index}>{fact}</span>
        ))}
      </p>
      <CollapsibleQuote text={card.instructions} />
      {!card.schedulerOn && <p className="routine-approval-note">{t("routines.schedulerOff")}</p>}
      <div className="routine-approval-actions">
        <ConfigButton variant="ghost" size="small" disabled={busy} onClick={() => respond(false)}>{t("routines.approval.decline")}</ConfigButton>
        <ConfigButton variant="primary" size="small" disabled={busy} onClick={() => respond(true)}>{t("routines.approval.create")}</ConfigButton>
      </div>
    </section>
  );
}
