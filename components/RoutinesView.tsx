"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { useI18n } from "@/hooks/useI18n";
import { useConfirm } from "@/hooks/useConfirm";
import { formatRelativeTime } from "@/lib/i18n/format";
import type { Routine, RoutineSchedule } from "@/lib/routines";
import type { SessionInfo } from "@/lib/types";
import {
  draftFromSchedule,
  defaultScheduleDraft,
  minIntervalMs,
  previewRuns,
  scheduleFromDraft,
  type ScheduleDraft,
} from "@/lib/routine-schedule";
import { THINKING_LEVELS, THINKING_LEVEL_LABELS } from "@/lib/thinking-levels";
import { clampThinkingLevelTo } from "@/lib/thinking-level";
import { exactToolPreset, getToolNamesForPreset } from "@/lib/tool-presets";
import {
  ConfigButton,
  ConfigSwitch,
  SettingsLoading,
  SettingsSegmented,
} from "./SettingsUi";
import { ModelSelector } from "./ModelSelector";
import { Select } from "./Select";
import { shortenPath, useModelOptions } from "./AgentEditor";
import { NewSessionCwdControl } from "./ChatWindow";
import { RoutineSchedulePicker, scheduleDraftProblem } from "./RoutineSchedulePicker";
import { RoutineOverview } from "./RoutineOverview";
import { describeSchedule, listJoin } from "@/lib/routine-summary";

type WorktreeInfo = Parameters<typeof NewSessionCwdControl>[0]["worktreeInfo"];

/**
 * Two cwds from the server, compared in the browser (no Node path rules here). Windows paths
 * (drive letter or UNC) are case-insensitive with either separator; POSIX paths are exact.
 */
function sameCwd(a: string, b: string): boolean {
  if (a === b) return true;
  const windows = (path: string) => /^[a-zA-Z]:[\\/]|^\\\\/.test(path);
  if (!windows(a) || !windows(b)) return false;
  const key = (path: string) => path.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return key(a) === key(b);
}

/** The project picker's display name for a path (sidebar name, else the folder name). */
function projectLabel(path: string, names: ReadonlyMap<string, string>): string {
  return names.get(path) ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
/** The composer's tool-preset glyph (ChatInput). */
function ToolsIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>;
}

// Design: docs/routines.md

type RoutineView = Routine & { nextRunAt: string | null };
interface RoutinesResponse { routines: RoutineView[]; schedulerEnabled: boolean; timeZone: string; error?: string }

// Same labels as the composer's tool picker; "configured" follows settings.json defaultTools.
const TOOL_PRESETS = ["configured", "chat-only", "read-only", "default", "full"] as const;
type ToolPresetLabel = typeof TOOL_PRESETS[number];

/**
 * The preset whose list matches exactly. Anything else (an API-written subset) is "custom"
 * and saved unchanged: rounding it to the nearest preset could grant bash/write unattended.
 */
function presetFromToolNames(toolNames: string[] | undefined): ToolPresetLabel | "custom" {
  const preset = exactToolPreset(toolNames);
  return preset === null ? "custom" : preset === "none" ? "chat-only" : preset;
}

function toolNamesFromPreset(preset: ToolPresetLabel): string[] | undefined {
  if (preset === "configured") return undefined;
  if (preset === "chat-only") return [];
  return getToolNamesForPreset(preset);
}

type RunMode = Routine["target"]["kind"];

interface Draft {
  name: string;
  prompt: string;
  /** new_session: a new chat each run; same_session: one continuing chat. */
  mode: RunMode;
  /** same_session: the chat to continue; null = the first run creates it. */
  sessionId: string | null;
  /** new_session: each run in its own throwaway git worktree. */
  worktree: boolean;
  cwd: string;
  /** Absent = follow settings `defaultTools`; [] = Chat only. */
  toolNames: string[] | undefined;
  model: { provider: string; modelId: string } | null;
  thinkingLevel: ThinkingLevel | "";
  schedule: ScheduleDraft;
  timeoutMinutes: number;
  enabled: boolean;
}

function draftFromRoutine(routine: Routine): Draft {
  const { target } = routine;
  return {
    name: routine.name,
    prompt: routine.prompt,
    mode: target.kind,
    sessionId: target.kind === "same_session" ? target.sessionId ?? null : null,
    worktree: target.worktree === true,
    cwd: target.cwd,
    toolNames: target.toolNames,
    model: target.model ?? null,
    thinkingLevel: target.thinkingLevel ?? "",
    schedule: draftFromSchedule(routine.schedule),
    timeoutMinutes: routine.timeoutMinutes,
    enabled: routine.enabled,
  };
}

function bodyFromDraft(draft: Draft, timeZone: string) {
  const { toolNames } = draft;
  return {
    name: draft.name,
    prompt: draft.prompt,
    enabled: draft.enabled,
    timeoutMinutes: draft.timeoutMinutes,
    schedule: scheduleFromDraft(draft.schedule, timeZone),
    target: {
      kind: draft.mode,
      ...(draft.mode === "same_session" && draft.sessionId ? { sessionId: draft.sessionId } : {}),
      ...(draft.mode === "new_session" && draft.worktree ? { worktree: true } : {}),
      cwd: draft.cwd,
      ...(toolNames ? { toolNames } : {}),
      ...(draft.model ? { model: draft.model } : {}),
      ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
    },
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

/** One-line schedule summary for the routine cards. */
function useScheduleText() {
  const { t, locale } = useI18n();
  return useCallback((schedule: RoutineSchedule) => describeSchedule(schedule, locale, t), [locale, t]);
}

// Absolute times use the server's zone: that is where schedules fire. 12-hour clock, like the time picker.
function formatWhen(value: string | Date, locale: string, timeZone: string): string {
  const date = new Date(value);
  // Relative within a month, absolute beyond (as ZCode/Claude show next runs).
  if (Math.abs(date.getTime() - Date.now()) < 30 * 86_400_000) return formatRelativeTime(date, locale as never);
  return date.toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h12", timeZone });
}

function formatStamp(value: string | Date, locale: string, timeZone: string): string {
  return new Date(value).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h12", timeZone });
}

type Page = { kind: "list" } | { kind: "detail"; id: string | null };

// Empty-state illustration: Claude's hand-drawn stopwatch, vectorized from its screenshot
// (potrace) rather than redrawn, so the wobbly outline and sketched hands stay as drawn.
// FACE is the dial's fill (the crown and its neck stay the page color); INK is every stroke.
const STOPWATCH_FACE = "M247 529C246 529 241 529 234 529C207 529 184 525 164 516C161 515 155 513 152 511C112 496 66 457 58 434C57 428 55 423 50 414C48 410 46 404 45 401C42 393 40 387 38 382C36 377 31 359 31 356C31 354 30 350 29 345C21 315 30 241 46 217C47 215 50 209 52 205C54 201 57 196 58 194C60 191 62 188 63 186C66 181 82 162 93 151C99 146 113 135 123 129C140 119 187 102 200 102C204 102 206 98 206 91C205 80 206 80 181 80L160 80L157 76L154 73L154 53L154 32L157 29L160 25L186 24C218 23 326 24 331 25C338 27 338 30 339 52C339 83 339 83 311 83C292 83 291 83 292 91C293 97 295 98 304 101C309 102 315 104 318 105C321 107 326 108 328 109C341 112 368 127 386 141C402 153 430 185 430 190C430 190 432 193 434 196C445 212 458 244 462 266C462 268 463 271 464 274C468 287 469 329 464 347C463 351 462 358 461 363C459 376 454 392 445 407C445 408 443 412 441 416C437 424 434 429 431 434C423 446 413 457 407 463C404 466 398 471 396 473C388 481 378 488 361 499C347 508 326 517 304 522C298 523 290 525 286 526C283 526 278 527 276 527C273 527 266 528 262 528C252 530 248 530 247 529ZM234 96C240 95 252 95 260 94C278 94 277 95 277 85C277 77 277 76 280 73L283 70L303 70C328 70 326 71 326 54C326 43 326 39 325 38C324 38 296 37 246 36L169 36L168 38C167 40 167 64 168 66C168 67 174 67 190 67C217 68 217 68 218 86C218 100 216 99 234 96Z";
const STOPWATCH_INK = "M247 529C246 529 241 529 234 529C207 529 184 525 164 516C161 515 155 513 152 511C138 506 116 494 106 487C86 471 62 445 58 434C57 428 55 423 50 414C48 410 46 404 45 401C42 393 40 387 38 382C36 377 31 359 31 356C31 354 30 350 29 345C25 333 25 289 29 271C34 245 39 226 46 217C47 215 50 209 52 205C54 201 57 196 58 194C60 191 62 188 63 186C66 181 82 162 93 151C99 146 113 135 123 129C140 119 187 102 200 102C204 102 206 98 206 91C205 80 206 80 181 80L160 80L157 76L154 73L154 53L154 32L157 29L160 25L186 24C218 23 326 24 331 25C338 27 338 30 339 52C339 83 339 83 311 83C292 83 291 83 292 91C293 97 295 98 304 101C309 102 315 104 318 105C321 107 326 108 328 109C335 111 362 124 371 130C391 144 410 161 422 178C427 184 430 189 430 190C430 190 432 193 434 196C445 212 458 244 462 266C462 268 463 271 464 274C468 287 469 329 464 347C463 351 462 358 461 363C459 376 454 392 445 407C445 408 443 412 441 416C437 424 434 429 431 434C423 446 413 457 407 463C404 466 398 471 396 473C388 481 378 488 361 499C347 508 326 517 304 522C298 523 290 525 286 526C283 526 278 527 276 527C273 527 266 528 262 528C252 530 248 530 247 529ZM254 515C267 515 285 513 294 510C299 508 306 506 310 505C314 504 320 502 325 500C329 498 336 495 340 493C348 490 352 488 363 480C368 476 375 471 379 469C394 459 414 435 425 414C426 412 428 409 429 406C435 398 439 389 439 388C439 387 440 385 440 384C443 378 446 368 448 361C448 357 450 351 450 348C453 338 454 310 452 293C445 235 431 206 391 166C377 152 375 151 363 143C344 132 334 127 326 124C322 123 316 120 313 119C291 109 260 107 228 113C223 113 215 115 210 116C202 117 187 120 176 124C173 124 169 125 167 126C165 126 163 127 162 128C160 128 159 129 158 129C155 129 137 138 130 144C126 146 119 151 114 154C99 164 79 185 73 198C72 200 70 203 68 205C64 210 54 231 50 241C40 271 37 319 43 346C44 349 45 354 46 357C47 363 50 372 54 384C56 389 58 394 59 396C59 399 62 404 64 409C66 413 68 418 68 418C68 420 73 431 76 436C88 454 102 468 115 475C119 477 125 481 128 484C139 491 154 498 186 508C200 512 231 516 244 515C248 515 252 515 254 515ZM248 342C246 341 243 339 242 338L240 335L239 249C239 160 239 157 243 155C247 153 248 154 251 159C252 162 252 166 253 245C253 320 253 327 254 329C256 330 257 330 272 321C291 310 301 304 312 297C317 294 326 290 330 287C335 284 340 281 341 280C342 280 345 278 349 277L355 274L358 277C364 282 361 288 347 294C342 296 334 301 328 304C323 307 314 312 308 315C301 319 294 323 292 324C266 342 254 346 248 342ZM234 96C240 95 252 95 260 94C268 94 275 94 276 94C277 93 277 90 277 85C277 77 277 76 280 73L283 70L303 70C314 70 324 69 325 69C326 68 326 64 326 54C326 43 326 39 325 38C324 38 296 37 246 36L169 36L168 38C167 40 167 64 168 66C168 67 174 67 190 67C217 68 217 68 218 86C218 100 216 99 234 96Z";

function RoutinesIcon() {
  return (
    <svg className="routines-empty-icon" width="84" height="96" viewBox="22 19 450 515" fillRule="evenodd" aria-hidden="true">
      <path className="routines-empty-icon-face" d={STOPWATCH_FACE} />
      <path fill="currentColor" d={STOPWATCH_INK} />
    </svg>
  );
}

function InfoIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
}

function ChevronRight() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>;
}

/**
 * Routines as a main-area view, a peer of the chat: a routine is a conversation the
 * agent starts on a schedule. `headerSlot` is the workspace header, where the
 * breadcrumb replaces the chat tabs.
 */
export function RoutinesView({ active, cwd, projectPaths, projectNameByRoot, worktreeInfo, sessions, headerSlot, openRequest, onPageChange, onOpenSession }: {
  /** The shown page, for the address bar: a routine's id, or null for the list or a new routine. */
  onPageChange?: (routineId: string | null) => void;
  /** Open this routine's detail page (a new object each request). */
  openRequest?: { id: string } | null;
  /** Shown; the view stays mounted while the chat is in front, but stops polling. */
  active: boolean;
  /** The sidebar's session list: the chats a continuing routine can pick. */
  sessions: readonly SessionInfo[];
  cwd: string | null;
  projectPaths: string[];
  projectNameByRoot: ReadonlyMap<string, string>;
  worktreeInfo: WorktreeInfo;
  headerSlot: HTMLElement | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t, locale } = useI18n();
  const confirm = useConfirm();
  const scheduleText = useScheduleText();
  const [data, setData] = useState<RoutinesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** detail id null = creating a new routine */
  const [page, setPage] = useState<Page>({ kind: "list" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const setDirty = useCallback((dirty: boolean) => { dirtyRef.current = dirty; }, []);
  const timeZone = data?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const refresh = useCallback(async () => {
    try {
      setData(await requestJson<RoutinesResponse>("/api/routines"));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    // Runs start and finish on the server; a slow poll keeps statuses current while shown.
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const routines = useMemo(() => data?.routines ?? [], [data]);
  const selected = page.kind === "detail" && page.id ? routines.find((routine) => routine.id === page.id) ?? null : null;
  const showDetail = page.kind === "detail" && (page.id === null || selected !== null);

  const runNow = async (routine: Routine) => {
    setBusyId(routine.id);
    setError(null);
    try {
      await requestJson(`/api/routines/${routine.id}/run`, { method: "POST" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const setEnabled = async (routine: Routine, enabled: boolean) => {
    setBusyId(routine.id);
    setError(null);
    try {
      await requestJson(`/api/routines/${routine.id}`, {
        method: "PATCH",
        // The stored definition as is: a round trip through the form must not touch the schedule.
        body: JSON.stringify({ name: routine.name, prompt: routine.prompt, enabled, timeoutMinutes: routine.timeoutMinutes, schedule: routine.schedule, target: routine.target }),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const discardEdits = async () => {
    if (dirtyRef.current && !await confirm(t("routines.discardConfirm"), { danger: true, confirmLabel: t("common.discard"), cancelLabel: t("common.keepEditing") })) return false;
    setDirty(false);
    return true;
  };

  const backToList = async () => {
    if (await discardEdits()) setPage({ kind: "list" });
  };

  const shownRoutineId = page.kind === "detail" ? page.id : null;
  useEffect(() => {
    if (active) onPageChange?.(shownRoutineId);
  }, [active, shownRoutineId, onPageChange]);

  // A chat asked to show a routine (a created-routine chip): open its detail page, once per request.
  const handledOpenRef = useRef<object | null>(null);
  useEffect(() => {
    if (!openRequest || handledOpenRef.current === openRequest) return;
    handledOpenRef.current = openRequest;
    void (async () => {
      if (dirtyRef.current && !await confirm(t("routines.discardConfirm"), { danger: true, confirmLabel: t("common.discard"), cancelLabel: t("common.keepEditing") })) return;
      setDirty(false);
      setPage({ kind: "detail", id: openRequest.id });
    })();
  }, [openRequest, confirm, setDirty, t]);

  // Only a routine's page has a trail; on the list the page's own title says "Routines".
  const breadcrumb = showDetail && (
    <nav aria-label={t("routines.title")} className="routines-breadcrumb">
      <button type="button" className="routines-breadcrumb-link" onClick={() => void backToList()}>{t("routines.title")}</button>
      <ChevronRight />
      <span aria-current="page" className="routines-breadcrumb-current">{selected?.name ?? t("routines.new")}</span>
    </nav>
  );

  return (
    <div className="routines-view">
      {headerSlot && breadcrumb && createPortal(breadcrumb, headerSlot)}
      <div className="routines-page">
        {showDetail ? (
          <RoutineDetail
            key={page.kind === "detail" ? page.id ?? "new" : "new"}
            routine={selected}
            timeZone={timeZone}
            defaultCwd={cwd ?? projectPaths[0] ?? ""}
            projectPaths={projectPaths}
            projectNameByRoot={projectNameByRoot}
            worktreeInfo={worktreeInfo}
            sessions={sessions}
            busy={busyId === selected?.id}
            runError={error}
            onDirtyChange={setDirty}
            onSaved={(routine) => { setDirty(false); setPage({ kind: "detail", id: routine.id }); void refresh(); }}
            onDeleted={() => { setDirty(false); setPage({ kind: "list" }); void refresh(); }}
            onRunNow={(routine) => void runNow(routine)}
            onSetEnabled={(routine, enabled) => void setEnabled(routine, enabled)}
            onCancel={() => void backToList()}
            onOpenSession={(sessionId) => void discardEdits().then((ok) => { if (ok) onOpenSession(sessionId); })}
          />
        ) : (
          <>
            <div className="routines-detail-bar">
              <header className="routines-page-header">
                <h1 className="routines-title">{t("routines.title")}</h1>
              </header>
              {routines.length > 0 && (
                <ConfigButton variant="primary" size="small" className="routines-button" onClick={() => setPage({ kind: "detail", id: null })}>{t("routines.new")}</ConfigButton>
              )}
            </div>
            {data && !data.schedulerEnabled && (
              <p role="status" className="routines-notice">
                <InfoIcon />
                <span>{t("routines.schedulerOff")}</span>
              </p>
            )}
            {error && <p role="alert" className="settings-row-message is-error">{error}</p>}
            {!data ? (
              <SettingsLoading label={t("i18n.loading")} />
            ) : routines.length === 0 ? (
              <div className="routines-empty" role="status" aria-label={t("routines.empty")}>
                <RoutinesIcon />
                <ConfigButton variant="primary" size="small" className="routines-button" onClick={() => setPage({ kind: "detail", id: null })}>{t("routines.new")}</ConfigButton>
              </div>
            ) : (
              <section aria-label={t("routines.title")} className="routine-cards">
                {routines.map((routine) => {
                  const last = routine.runs[0];
                  // Not just runs[0]: a skipped overlap is recorded above the run still going.
                  const running = routine.runs.some((run) => run.status === "running");
                  // One quiet line: state first (paused / running / next), then the last result.
                  const state = running ? t("routines.status.running")
                    : !routine.enabled ? t("routines.paused")
                      : routine.nextRunAt ? t("routines.nextRun", { when: formatWhen(routine.nextRunAt, locale, timeZone) })
                        : routine.schedule.kind === "manual" ? t("routines.summary.manual") : t("routines.ended");
                  return (
                    <article key={routine.id} className={`routine-card${routine.enabled ? "" : " is-paused"}`}>
                      <button type="button" className="routine-card-main" onClick={() => setPage({ kind: "detail", id: routine.id })}>
                        <span className="routine-card-name">{routine.name}</span>
                        <span className="routine-card-schedule">
                          <span className="routine-card-schedule-text">{scheduleText(routine.schedule)}</span>
                          {routine.target.kind === "same_session" && <span className="routine-card-tag">{t("routines.mode.sameShort")}</span>}
                        </span>
                        <span className="routine-card-meta">
                          <span className={`routine-card-state${running ? " is-running" : routine.enabled ? "" : " is-paused"}`}>{state}</span>
                          {last && !running && (
                            <span className={last.status === "failed" || last.status === "timed_out" ? "is-bad" : undefined}>
                              {t("routines.lastRun", { status: t(`routines.status.${last.status}`), when: formatWhen(last.startedAt, locale, timeZone) })}
                            </span>
                          )}
                        </span>
                      </button>
                      {/* Only the switch: running by hand is occasional, so it lives on the routine's page. */}
                      <div className="routine-card-side">
                        <ConfigSwitch
                          checked={routine.enabled}
                          loading={busyId === routine.id}
                          label={routine.enabled ? t("routines.pause") : t("routines.resume")}
                          onChange={(enabled) => void setEnabled(routine, enabled)}
                        />
                      </div>
                    </article>
                  );
                })}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RoutineDetail({ routine, timeZone, defaultCwd, projectPaths, projectNameByRoot, worktreeInfo, sessions, busy, runError, onDirtyChange, onSaved, onDeleted, onRunNow, onSetEnabled, onCancel, onOpenSession }: {
  routine: RoutineView | null;
  timeZone: string;
  defaultCwd: string;
  projectPaths: string[];
  projectNameByRoot: ReadonlyMap<string, string>;
  worktreeInfo: WorktreeInfo;
  sessions: readonly SessionInfo[];
  busy: boolean;
  runError: string | null;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (routine: Routine) => void;
  onDeleted: () => void;
  onRunNow: (routine: Routine) => void;
  onSetEnabled: (routine: Routine, enabled: boolean) => void;
  onCancel: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t, locale } = useI18n();
  // An existing routine opens as an overview; the pencil (or a new routine) shows the form.
  const [editing, setEditing] = useState(routine === null);
  const confirm = useConfirm();
  const [initial, setInitial] = useState<Draft>(() => routine ? draftFromRoutine(routine) : {
    name: "",
    prompt: "",
    mode: "new_session",
    sessionId: null,
    worktree: false,
    cwd: defaultCwd,
    toolNames: undefined,
    model: null,
    thinkingLevel: "",
    schedule: defaultScheduleDraft(),
    timeoutMinutes: 30,
    enabled: true,
  });
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const models = useModelOptions(draft.cwd || defaultCwd);
  const modelOptions = useMemo(() => models.options.map((model) => ({ provider: model.provider, modelId: model.id, name: model.name })), [models.options]);
  // Like the chat composer, always show the concrete model and thinking level a run will use.
  const levelsFor = (model: Draft["model"]) => model ? models.data?.thinkingLevels?.[`${model.provider}:${model.modelId}`] : undefined;
  const defaultThinkingFor = (model: Draft["model"]): string => {
    if (!model) return "";
    const pinned = models.data?.thinkingLevelPins?.[`${model.provider}/${model.modelId}`];
    if (pinned) return pinned;
    const fallback = models.data?.defaultThinkingLevel;
    return fallback ? clampThinkingLevelTo(levelsFor(model), fallback) : "";
  };
  const defaultModel = models.data?.defaultModel ?? null;
  const effectiveModel = draft.model ?? defaultModel;
  const effectiveThinking = draft.thinkingLevel || defaultThinkingFor(effectiveModel);
  const thinkingChoices = THINKING_LEVELS.filter((level) => !levelsFor(effectiveModel) || levelsFor(effectiveModel)!.includes(level));
  // A new routine pins today's defaults, as a new chat does; the form then shows what it saves.
  if (!routine && !draft.model && defaultModel) {
    const next = { ...draft, model: defaultModel, thinkingLevel: (draft.thinkingLevel || defaultThinkingFor(defaultModel)) as Draft["thinkingLevel"] };
    setDraft(next);
    setInitial(next);
  }
  const chooseModel = (provider: string, modelId: string) => setDraft((current) => ({
    ...current,
    model: { provider, modelId },
    thinkingLevel: (effectiveThinking ? clampThinkingLevelTo(levelsFor({ provider, modelId }), effectiveThinking) : "") as Draft["thinkingLevel"],
  }));

  // Grows with the text like the chat composer; CSS sets the taller resting height and the cap.
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fitPrompt = useCallback(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);
  useLayoutEffect(fitPrompt, [draft.prompt, fitPrompt]);
  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    let width = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      fitPrompt();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [fitPrompt, editing]);

  // `enabled` is switched from the list and the server; it never makes the form dirty.
  const dirty = JSON.stringify({ ...draft, enabled: null }) !== JSON.stringify({ ...initial, enabled: null });
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  // Follow saves from here or elsewhere while the form is clean; unsaved edits are never replaced.
  const [syncedAt, setSyncedAt] = useState(routine?.updatedAt);
  if (routine && routine.updatedAt !== syncedAt && !dirty) {
    const next = draftFromRoutine(routine);
    setSyncedAt(routine.updatedAt);
    setInitial(next);
    setDraft(next);
  }

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const updateSchedule = (patch: Partial<ScheduleDraft>) => setDraft((current) => ({ ...current, schedule: { ...current.schedule, ...patch } }));
  // Only schedule edits recompute; typing the name or instructions must not rerun cron.
  const schedule = useMemo(() => scheduleFromDraft(draft.schedule, timeZone), [draft.schedule, timeZone]);
  const minGap = minIntervalMs(draft.mode);
  const preview = useMemo(() => previewRuns(schedule, timeZone, 3, new Date(), minGap), [schedule, timeZone, minGap]);
  const boundChat = routine?.target.kind === "same_session" && Boolean(routine.target.sessionId);
  // Chats of this project, newest first; the bound chat stays listed even if it scrolled away.
  const chatChoices = useMemo(() => {
    const ofProject = sessions
      .filter((session) => sameCwd(session.cwd, draft.cwd) && session.relation?.kind !== "subagent" && !session.routineRunOnly)
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .slice(0, 50);
    const label = (session: SessionInfo) => (session.name || session.firstMessage || session.id).replace(/\s+/g, " ").slice(0, 80);
    const options = ofProject.map((session) => ({ value: session.id, label: label(session) }));
    if (draft.sessionId && !options.some((option) => option.value === draft.sessionId)) {
      options.unshift({ value: draft.sessionId, label: t("routines.chat.bound") });
    }
    // A saved routine's bound chat stays bound (the server keeps it), so "new on the first run" is gone.
    return boundChat ? options : [{ value: "", label: t("routines.chat.createOnFirstRun") }, ...options];
  }, [sessions, draft.cwd, draft.sessionId, boundChat, t]);
  const continuesChat = draft.mode === "same_session" && draft.sessionId !== null;
  // Whether the project is a git checkout: only then can a run get its own worktree.
  const [isGit, setIsGit] = useState(false);
  useEffect(() => {
    if (!draft.cwd) return;
    const controller = new AbortController();
    fetch(`/api/worktrees?cwd=${encodeURIComponent(draft.cwd)}`, { signal: controller.signal, cache: "no-store" })
      .then((response) => (response.ok ? response.json() as Promise<{ isGit?: boolean }> : null))
      .then((data) => setIsGit(data?.isGit === true))
      .catch(() => {});
    return () => controller.abort();
  }, [draft.cwd]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // The server keeps a chat bound since this form loaded (RoutineStore.update).
      const body = JSON.stringify(bodyFromDraft({ ...draft, enabled: routine?.enabled ?? draft.enabled }, timeZone));
      const { routine: saved } = routine
        ? await requestJson<{ routine: Routine }>(`/api/routines/${routine.id}`, { method: "PATCH", body })
        : await requestJson<{ routine: Routine }>("/api/routines", { method: "POST", body });
      const next = draftFromRoutine(saved);
      setSyncedAt(saved.updatedAt);
      setInitial(next);
      setDraft(next);
      setEditing(false);
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!routine || !await confirm(t("routines.deleteConfirm", { name: routine.name }), { danger: true, confirmLabel: t("i18n.delete") })) return;
    try {
      await requestJson(`/api/routines/${routine.id}`, { method: "DELETE" });
      onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // Same check as a new chat's picker: the server resolves and validates the directory.
  const changeCwd = async (path: string) => {
    const { cwd: resolved } = await requestJson<{ cwd: string }>("/api/cwd/validate", { method: "POST", body: JSON.stringify({ cwd: path }) });
    // Another project's chat cannot be continued here.
    setDraft((current) => ({ ...current, cwd: resolved, sessionId: current.cwd === resolved ? current.sessionId : null }));
  };
  const toolPreset = presetFromToolNames(draft.toolNames);
  const problem = scheduleDraftProblem(draft.schedule);
  const scheduleIssue = problem ? t(`routines.schedule.${problem}`)
    : preview.error ?? (schedule.kind !== "manual" && preview.runs.length === 0 && draft.enabled ? t("routines.schedule.neverRuns")
      : preview.tooOften ? t("routines.schedule.tooOften", { minutes: minGap / 60_000 }) : null);
  const canSave = !saving && (routine === null || dirty) && Boolean(draft.name.trim() && draft.prompt.trim() && draft.cwd) && !scheduleIssue;
  const shownError = error ?? runError;

  // Leaving the form: an existing routine goes back to its overview, a new one to the list.
  const cancelEdit = async () => {
    if (!routine) return onCancel();
    if (dirty && !await confirm(t("routines.discardConfirm"), { danger: true, confirmLabel: t("common.discard"), cancelLabel: t("common.keepEditing") })) return;
    setDraft(initial);
    setError(null);
    setEditing(false);
  };

  if (routine && !editing) {
    const model = routine.target.model;
    return (
      <RoutineOverview
        routine={routine}
        timeZone={timeZone}
        projectLabel={projectLabel(routine.target.cwd, projectNameByRoot)}
        modelName={model ? models.options.find((option) => option.provider === model.provider && option.id === model.modelId)?.name ?? model.modelId : null}
        sessions={sessions}
        busy={busy}
        error={shownError}
        onEdit={() => setEditing(true)}
        onDelete={() => void remove()}
        onRunNow={() => onRunNow(routine)}
        onSetEnabled={(enabled) => onSetEnabled(routine, enabled)}
        onOpenSession={onOpenSession}
      />
    );
  }

  return (
    // The form keeps a reading width inside the wider list/overview page.
    <div className="routines-edit">
      <div className="routines-detail-bar">
        <header className="routines-page-header">
          <h1 className="routines-title">{routine ? t("routines.editTitle", { name: routine.name }) : t("routines.new")}</h1>
          {/* A new routine needs no subtitle: the fields say what to fill in. */}
          {routine && <p className="routines-subtitle" title={draft.cwd}>{shortenPath(draft.cwd)}</p>}
        </header>
      </div>
      {shownError && <p role="alert" className="settings-row-message is-error">{shownError}</p>}

        <div className="settings-form routines-form">
          <label className="config-field">
            <span className="config-field-label">{t("routines.name")}</span>
            <input value={draft.name} maxLength={80} placeholder={t("routines.namePlaceholder")} onChange={(event) => update("name", event.target.value)} />
          </label>

          <div className="routines-field">
            <span className="config-field-label">{t("routines.prompt")}</span>
            {/* The chat composer at page width: same frame, toolbar and labels, taller at rest. */}
            <div className="chat-input routines-composer">
              <div className="chat-input-composer">
                <div className="chat-input-field-row">
                  <textarea
                    ref={promptRef}
                    rows={1}
                    className="chat-input-textarea routines-composer-textarea"
                    aria-label={t("routines.prompt")}
                    value={draft.prompt}
                    placeholder={t("routines.promptPlaceholder")}
                    onChange={(event) => update("prompt", event.target.value)}
                  />
                </div>
                <div className="chat-input-dock">
                  {continuesChat ? (
                    // A continued chat runs with its own model, thinking level and tools.
                    <span className="routines-composer-note">{t("routines.chat.followsSession")}</span>
                  ) : (
                    <>
                      <ModelSelector
                        options={modelOptions}
                        value={effectiveModel}
                        onChange={chooseModel}
                        emptyLabel={models.loading ? t("agents.modelsLoading") : t("routines.chooseModel")}
                        disabled={models.loading}
                        ariaLabel={t("routines.model")}
                      />
                      {effectiveThinking && (
                        <Select
                          className="composer-btn"
                          placement="up"
                          ariaLabel={t("routines.thinking")}
                          value={effectiveThinking}
                          onChange={(value) => update("thinkingLevel", value as Draft["thinkingLevel"])}
                          options={thinkingChoices.map((level) => ({ value: level, label: THINKING_LEVEL_LABELS[level] }))}
                        />
                      )}
                    </>
                  )}
                  <span className="chat-input-dock-spacer" />
                  {routine ? (
                    <span className="routines-composer-project" title={draft.cwd}>{projectLabel(draft.cwd, projectNameByRoot)}</span>
                  ) : (
                    // The new-chat project picker: project names, worktrees, custom path.
                    <NewSessionCwdControl
                      cwd={draft.cwd}
                      onChange={changeCwd}
                      projectPaths={projectPaths}
                      projectNameByRoot={projectNameByRoot}
                      worktreeInfo={worktreeInfo}
                      placement="above"
                    />
                  )}
                  {/* As in the chat composer: the default ("configured") is just the icon; other presets name themselves. */}
                  {!continuesChat && (
                    <Select
                      className={`composer-btn${toolPreset === "configured" ? " is-icon" : ""}`}
                      icon={<ToolsIcon />}
                      label={toolPreset === "configured" ? "" : undefined}
                      align="end"
                      placement="up"
                      ariaLabel={t("routines.tools")}
                      value={toolPreset}
                      onChange={(value) => { if (value !== "custom") update("toolNames", toolNamesFromPreset(value as ToolPresetLabel)); }}
                      options={[
                        ...TOOL_PRESETS.map((preset) => ({ value: preset, label: preset })),
                        ...(toolPreset === "custom" ? [{ value: "custom", label: draft.toolNames!.join(", ") }] : []),
                      ]}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="routines-field">
            <span className="config-field-label">{t("routines.mode")}</span>
            <div className="routines-mode">
              <SettingsSegmented
                label={t("routines.mode")}
                value={draft.mode}
                onChange={(mode) => update("mode", mode)}
                options={[
                  { value: "new_session", label: t("routines.mode.new_session") },
                  { value: "same_session", label: t("routines.mode.same_session") },
                ]}
              />
              {draft.mode === "same_session" && (
                <span className="routines-schedule-item">
                  <span className="routines-schedule-label">{t("routines.chat")}</span>
                  <Select
                    className="select-trigger routines-schedule-control routines-chat-select"
                    ariaLabel={t("routines.chat")}
                    value={draft.sessionId ?? ""}
                    onChange={(value) => update("sessionId", value || null)}
                    options={chatChoices}
                  />
                </span>
              )}
            </div>
            <p className="settings-row-message">{t(draft.mode === "same_session" ? "routines.mode.sameHint" : "routines.mode.newHint")}</p>
            {/* Like Claude's Worktree box: offered for git projects, new chats only. */}
            {draft.mode === "new_session" && (isGit || draft.worktree) && (
              // A text-sized checkbox in the app's own style (the sidebar's selection box), centered on
              // the first line: a 36px switch hung beside two lines of text looked off.
              <label className="routines-worktree">
                <input type="checkbox" className="sidebar-session-checkbox" checked={draft.worktree} onChange={(event) => update("worktree", event.target.checked)} />
                <span className="routines-worktree-text">
                  <span>{t("routines.worktree")}</span>
                  <span className="routines-worktree-hint">{t("routines.worktreeHint")}</span>
                </span>
              </label>
            )}
          </div>

          <div className="routines-field">
            <span className="config-field-label">{t("routines.scheduleTitle")}</span>
            <RoutineSchedulePicker draft={draft.schedule} onChange={updateSchedule} />
            <p className={`settings-row-message${scheduleIssue ? " is-error" : ""}`}>
              {scheduleIssue
                ?? (schedule.kind === "manual"
                  ? t("routines.manualHint")
                  : t("routines.upcoming", { timeZone, runs: preview.runs.map((run) => formatStamp(run, locale, timeZone)).join(listJoin(locale)) }))}
            </p>
          </div>

          <label className="config-field routines-timeout">
            <span className="config-field-label">{t("routines.timeout")}</span>
            <input type="number" min={1} max={720} value={draft.timeoutMinutes} onChange={(event) => update("timeoutMinutes", Number(event.target.value))} />
          </label>

          <div className="routines-form-actions">
            <ConfigButton size="small" className="routines-button" onClick={() => void cancelEdit()}>{t("routines.cancel")}</ConfigButton>
            <ConfigButton variant="primary" size="small" className="routines-button" disabled={!canSave} onClick={() => void save()}>
              {saving ? t("agents.saving") : routine ? t("routines.save") : t("routines.create")}
            </ConfigButton>
          </div>
        </div>
    </div>
  );
}
