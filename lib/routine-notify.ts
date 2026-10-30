import { interpolateMessage } from "./i18n/format";
import { enLocale } from "./i18n/messages/en";
import { zhCNLocale } from "./i18n/messages/zh-CN";
import type { Routine, RoutineRun } from "./routines";
import { sendNotification } from "./web-push";

// Design: docs/routines.md ("Notifications"). A successful run needs nothing here: its chat
// ends like any other and sends the usual "session complete" push.

export type RoutineNoticeKind = "failed" | "timed_out" | "skipped" | "paused" | "catch_up";

export interface RoutineNotice {
  routine: Pick<Routine, "id" | "name">;
  run: Pick<RoutineRun, "sessionId" | "skipReason" | "error" | "scheduledFor">;
  kind: RoutineNoticeKind;
}

const TITLE_KEY: Record<RoutineNoticeKind, string> = {
  failed: "push.routineFailed",
  timed_out: "push.routineTimedOut",
  skipped: "push.routineSkipped",
  paused: "push.routinePaused",
  catch_up: "push.routineCatchUp",
};

/** The push for one routine event, in a subscriber's language (English unless zh-CN). */
export function routineNoticePayload(notice: RoutineNotice, locale: string): { title: string; body: string; url: string; tag: string } {
  const messages = locale === "zh-CN" ? zhCNLocale.messages : enLocale.messages;
  const t = (key: string, params?: Record<string, string | number>) => interpolateMessage(messages[key] ?? enLocale.messages[key] ?? key, params);
  const { routine, run, kind } = notice;
  const body = kind === "skipped" && run.skipReason ? t(`routines.skip.${run.skipReason}`)
    : kind === "paused" ? t("push.routinePausedBody")
      : kind === "catch_up" ? t("push.routineCatchUpBody")
        : run.error || t(`routines.status.${kind}`);
  return {
    title: t(TITLE_KEY[kind], { name: routine.name }),
    body,
    // A run with a chat opens it; otherwise the routine's page (docs/routines.md, URL state).
    url: run.sessionId && kind !== "skipped" ? `/?session=${encodeURIComponent(run.sessionId)}` : `/?routines=${encodeURIComponent(routine.id)}`,
    // A failed run's chat already sent its "session complete" push: replace that one. Otherwise one
    // slot per routine, so a routine that keeps skipping replaces its notice instead of stacking.
    tag: kind === "failed" && run.sessionId ? `pi-session-complete:${run.sessionId}` : `pi-routine:${routine.id}`,
  };
}

/** Fire and forget: a failed push must never affect the run. */
export function notifyRoutine(notice: RoutineNotice): void {
  const { url, tag } = routineNoticePayload(notice, "en");
  void sendNotification((locale) => {
    const { title, body } = routineNoticePayload(notice, locale);
    return { title, body };
  }, url, tag).catch((error) => {
    console.error("[pi-web] routine notification failed:", error instanceof Error ? error.message : error);
  });
}
