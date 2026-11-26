"use client";

import { useI18n } from "@/hooks/useI18n";
import type { SessionStatus } from "@/lib/session-status";

const LABEL_KEYS: Record<SessionStatus, string> = {
  awaiting: "sidebar.awaitingInput",
  error: "sidebar.sessionError",
  unread: "sidebar.newSessionActivity",
  running: "sidebar.agentRunning",
};

/** The one state mark: an 8px dot (docs/ui.md, Session state). Colors and the breathing live in CSS. */
export function SessionStatusDot({ status, title }: { status: SessionStatus; title?: string }) {
  const { t } = useI18n();
  const label = t(LABEL_KEYS[status]);
  return <span role="img" className="session-status-dot" data-status={status} title={title ?? label} aria-label={label} />;
}

/** Waiting and error rows say so in a word where the relative time would be. */
export function SessionStatusWord({ status }: { status: "awaiting" | "error" }) {
  const { t } = useI18n();
  return <span className="session-status-word" data-status={status}>{t(status === "awaiting" ? "sidebar.awaitingWord" : "sidebar.errorWord")}</span>;
}
