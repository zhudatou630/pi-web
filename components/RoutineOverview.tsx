"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";
import type { Routine, RoutineRun } from "@/lib/routines";
import { describeSchedule } from "@/lib/routine-summary";
import { THINKING_LEVEL_LABELS } from "@/lib/thinking-levels";
import { exactToolPreset } from "@/lib/tool-presets";
import type { SessionInfo } from "@/lib/types";
import { CollapsibleQuote } from "./CollapsibleQuote";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

type RoutineView = Routine & { nextRunAt: string | null };

/** Absolute in the server's zone, 12-hour clock, like the rest of the page. */
function stamp(value: string | Date, locale: string, timeZone: string): string {
  return new Date(value).toLocaleString(locale, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h12", timeZone });
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="routine-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const glyph = (size: number, path: ReactNode, className?: string) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size === 12 ? 2.2 : size === 13 ? 2 : 1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>
);

function RunIcon({ status }: { status: RoutineRun["status"] }) {
  if (status === "running") return <span className="routine-run-icon is-running" aria-hidden="true" />;
  if (status === "succeeded") return glyph(13, <><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.5 2.5 4.5-5" /></>, "routine-run-icon");
  if (status === "skipped") return glyph(13, <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />, "routine-run-icon");
  return glyph(13, <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5l5 5M14.5 9.5l-5 5" /></>, "routine-run-icon is-bad");
}

/**
 * An existing routine at a glance, after Claude's view: its name and actions head the page
 * (inside the page's width, like the list's title and New button, not out in the workspace
 * header); its settings as label-over-value facts on the left; the instructions and the run
 * history on the right. Editing is a separate step (the pencil).
 * Design: docs/routines.md (UI).
 */
export function RoutineOverview({
  routine, timeZone, projectLabel, modelName, sessions, busy, error,
  onEdit, onDelete, onRunNow, onSetEnabled, onOpenSession,
}: {
  routine: RoutineView;
  timeZone: string;
  projectLabel: string;
  /** Display name of the routine's model, when it pins one. */
  modelName: string | null;
  sessions: readonly SessionInfo[];
  busy: boolean;
  error: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onRunNow: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t, locale } = useI18n();
  const { target, schedule } = routine;
  // Not just runs[0]: a skipped overlap is recorded above the run still going.
  const running = routine.runs.some((run) => run.status === "running");
  const boundChat = target.kind === "same_session" && target.sessionId
    ? sessions.find((session) => session.id === target.sessionId) ?? null
    : null;
  const next = routine.nextRunAt
    ? t("routines.approval.nextAt", { when: stamp(routine.nextRunAt, locale, timeZone), relative: formatRelativeTime(new Date(routine.nextRunAt), locale as never) })
    : schedule.kind === "manual" ? t("routines.manualHint")
      : routine.enabled ? t("routines.ended") : null;
  const preset = exactToolPreset(target.toolNames);
  const tools = target.toolNames === undefined ? t("routines.overview.defaultTools")
    : preset === "none" ? t("routines.overview.chatOnly")
      : preset ?? target.toolNames.join(", ");
  const continuesChat = target.kind === "same_session" && Boolean(target.sessionId);
  const state = running ? t("routines.status.running") : routine.enabled ? t("routines.overview.active") : t("routines.paused");

  const iconButton = (label: string, onClick: () => void, path: ReactNode) => (
    <button type="button" className="ghost-icon-button" title={label} aria-label={label} onClick={onClick}>
      {glyph(13, path)}
    </button>
  );

  return (
    <>
      <div className="routines-detail-bar routine-overview-head">
        <h1 className="routines-title">{routine.name}</h1>
        <div className="routines-detail-actions">
          {iconButton(t("routines.edit"), onEdit, <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>)}
          {iconButton(t("routines.deleteTitle"), onDelete, <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>)}
          <ConfigButton size="small" disabled={busy || running} title={running ? t("routines.runningNow") : t("routines.runNowDescription")} onClick={onRunNow}>
            {glyph(12, <path d="M7 5v14l11-7Z" />)}
            <span>{t("routines.runNow")}</span>
          </ConfigButton>
        </div>
      </div>
      {error && <p role="alert" className="settings-row-message is-error">{error}</p>}

      <div className="routine-overview">
        <dl className="routine-facts">
          <Fact label={t("routines.overview.status")}>
            <span className="routine-status">
              <ConfigSwitch
                checked={routine.enabled}
                loading={busy}
                label={routine.enabled ? t("routines.pause") : t("routines.resume")}
                onChange={onSetEnabled}
              />
              <span className={`routine-pill${running ? " is-running" : ""}`}>{state}</span>
            </span>
          </Fact>
          <Fact label={t("routines.scheduleTitle")}>
            <span>{describeSchedule(schedule, locale, t)}</span>
            {next && <span className="routine-fact-sub">{next}</span>}
          </Fact>
          {/* Where and how each run happens, as one row of chips rather than a column of facts. */}
          <Fact label={t("routines.overview.setup")}>
            <span className="routine-chips">
              {target.kind === "new_session" ? (
                <span className="routine-chip">{glyph(12, <><path d="M12 5v14M5 12h14" /></>)}<span>{t("routines.mode.new_session")}</span></span>
              ) : target.sessionId ? (
                <button type="button" className="routine-chip is-link" title={t("routines.openSession")} onClick={() => onOpenSession(target.sessionId!)}>
                  {glyph(12, <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />)}
                  <span>{boundChat?.name || boundChat?.firstMessage || t("routines.chat.bound")}</span>
                </button>
              ) : (
                <span className="routine-chip" title={t("routines.chat.createOnFirstRun")}>{glyph(12, <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />)}<span>{t("routines.mode.same_session")}</span></span>
              )}
              <span className="routine-chip" title={target.cwd}>
                {glyph(12, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />)}
                <span>{projectLabel}</span>
              </span>
              {target.kind === "new_session" && target.worktree && (
                <span className="routine-chip" title={t("routines.worktreeHint")}>
                  {glyph(12, <><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 8v8M18 10a6 6 0 0 1-6 6H8" /></>)}
                  <span>{t("routines.overview.worktree")}</span>
                </span>
              )}
              {!continuesChat && (
                <>
                  <span className="routine-chip">
                    {glyph(12, <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6v6H9z" /></>)}
                    <span>{modelName ?? t("routines.overview.defaultModel")}{target.thinkingLevel && ` · ${THINKING_LEVEL_LABELS[target.thinkingLevel]}`}</span>
                  </span>
                  <span className="routine-chip">
                    {glyph(12, <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />)}
                    <span>{tools}</span>
                  </span>
                </>
              )}
              <span className="routine-chip" title={t("routines.overview.timeout")}>
                {glyph(12, <><path d="M10 2h4" /><circle cx="12" cy="14" r="7" /><path d="M12 10v4" /></>)}
                <span>{t("routines.overview.timeoutValue", { count: routine.timeoutMinutes })}</span>
              </span>
            </span>
          </Fact>
        </dl>

        <div className="routine-overview-main">
          <section aria-label={t("routines.prompt")}>
            <h2 className="routine-section-label">{t("routines.prompt")}</h2>
            <CollapsibleQuote text={routine.prompt} plain />
          </section>
          <section aria-label={t("routines.tab.history")}>
            <h2 className="routine-section-label">{t("routines.tab.history")}</h2>
            {routine.runs.length === 0 ? (
              <p className="routine-empty-line">{t("routines.noRuns")}</p>
            ) : (
              <ul className="routine-runs">
                {routine.runs.map((run) => {
                  const bad = run.status === "failed" || run.status === "timed_out" || run.status === "aborted";
                  const note = [
                    run.status === "succeeded" ? null : t(`routines.status.${run.status}`),
                    run.skipReason && t(`routines.skip.${run.skipReason}`),
                    run.trigger !== "schedule" && t(`routines.trigger.${run.trigger}`),
                    run.branch && t("routines.overview.branch", { branch: run.branch }),
                  ].filter(Boolean).join(" · ");
                  const content = (
                    <>
                      <RunIcon status={run.status} />
                      <span className="routine-run-time">{stamp(run.scheduledFor ?? run.startedAt, locale, timeZone)}</span>
                      <span className="routine-run-note" title={run.error ?? (note || undefined)}>{note}</span>
                      {run.sessionId && glyph(12, <path d="m9 18 6-6-6-6" />, "routine-run-open")}
                    </>
                  );
                  return (
                    <li key={run.runId}>
                      {run.sessionId ? (
                        <button type="button" className={`routine-run is-link${bad ? " is-bad" : ""}`} title={t("routines.openSession")} onClick={() => onOpenSession(run.sessionId!)}>
                          {content}
                        </button>
                      ) : (
                        <div className={`routine-run${bad ? " is-bad" : ""}`}>{content}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
