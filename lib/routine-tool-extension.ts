import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { minIntervalMs, nextRuns, type RoutineSchedule } from "./routine-schedule";
import { describeSchedule, type Translate } from "./routine-summary";
import { interpolateMessage } from "./i18n/format";
import { enLocale } from "./i18n/messages/en";
import { parseRoutineInput, RoutineStore, validateSchedule, type Routine, type RoutineInput, type RoutineRun } from "./routines";
import { isRoutineSchedulerEnabled } from "./routine-scheduler-flag";
import { readSessionToolSelection } from "./session-tool-selection";
import type { RoutineApprovalCard, SessionEntry } from "./types";
import { ASK_USER_TOOL_NAME, registerAskUserTool } from "./ask-user-extension";
import { hasWriteCapableTool } from "./read-only-tool-guard";
import { resolveProject } from "./worktree";
import { samePath } from "./paths";

// Design: docs/routines.md ("Create from chat").

export const ROUTINE_TOOL_NAME = "create_routine";
/** Lists the project's routines, or changes one (replaced `list_routines` and `update_routine`). */
export const ROUTINES_TOOL_NAME = "routines";
/** An unattended run (or a closed tab) must not hold the turn forever; no answer = not created. */
const CONFIRM_TIMEOUT_MS = 15 * 60_000;

export interface RoutineToolParams {
  name: string;
  instructions: string;
  run_in: "new_chat" | "this_chat";
  /** One 5-field cron expression, or */
  cron?: string;
  /** one run at YYYY-MM-DDTHH:mm. */
  at?: string;
}

/** What the tool knows about the chat it is called from. */
export interface RoutineToolChat {
  sessionId: string;
  cwd: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  /** The chat's tool selection; undefined follows settings `defaultTools`. */
  toolNames?: string[];
}

/**
 * The tool's arguments as a routine, validated like a form save (parseRoutineInput). A new
 * chat each run copies this chat's model, thinking level and tools; "this chat" keeps its own.
 * Rarer shapes (several times a day, every 2 weeks, an end date) are edited on the Routines page.
 */
export function routineInputFromToolParams(params: RoutineToolParams, chat: RoutineToolChat): RoutineInput {
  const { cron, at } = params;
  if (Boolean(cron?.trim()) === Boolean(at)) throw new Error("give exactly one of cron or at");
  const schedule: RoutineSchedule = at ? { kind: "once", at } : { kind: "cron", exprs: [cron!] };
  const target = params.run_in === "this_chat"
    ? { kind: "same_session", cwd: chat.cwd, sessionId: chat.sessionId }
    : {
        kind: "new_session",
        cwd: chat.cwd,
        ...(chat.toolNames ? { toolNames: chat.toolNames } : {}),
        ...(chat.model ? { model: chat.model } : {}),
        ...(chat.thinkingLevel ? { thinkingLevel: chat.thinkingLevel } : {}),
      };
  return parseRoutineInput({ name: params.name, prompt: params.instructions, enabled: true, schedule, target });
}

// The card is server text and the browser's language is unknown here, so it is English.
const en: Translate = (key, params) => interpolateMessage(enLocale.messages[key] ?? key, params);
const stamp = (date: Date) => date.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function relative(date: Date, now: Date): string {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 48 * 60) return `in ${Math.round(minutes / 60)} h`;
  return `in ${Math.round(minutes / 1440)} days`;
}

/** "Mon, Nov 2, 9:00 AM (in 3 days)", or "none". */
function nextRunText(input: RoutineInput, now: Date): string {
  if (!input.enabled) return "none (paused)";
  const [next] = nextRuns(input.schedule, undefined, 1, now);
  return next ? `${stamp(next)} (${relative(next, now)})` : "none";
}

/**
 * The confirmation card (markdown), short like Claude's: when it runs and when next, where
 * each run happens, and the instructions. Model, tools and project are this chat's own.
 */
export function routineConfirmMessage(input: RoutineInput, now = new Date(), schedulerOn = true): string {
  const instructions = input.prompt.length > 400 ? `${input.prompt.slice(0, 400)}…` : input.prompt;
  return [
    `**${describeSchedule(input.schedule, "en", en)}** · next ${nextRunText(input, now)}`,
    "",
    input.target.kind === "same_session" ? "Each run continues this chat." : "Each run starts a new chat.",
    ...(schedulerOn ? [] : ["", "_Scheduling is off in this Pi Web process: it runs only when you click Run now._"]),
    "",
    ...instructions.split("\n").map((line) => `> ${line}`),
  ].join("\n");
}

export interface UpdateRoutineParams {
  id: string;
  name?: string;
  instructions?: string;
  cron?: string;
  at?: string;
  enabled?: boolean;
}

const UPDATE_FIELDS = ["name", "instructions", "cron", "at", "enabled"] as const;

/**
 * The stored routine with the chat's partial change applied, validated like a form save.
 * Only name, instructions, schedule and on/off: where it runs (project, chat, model, tools)
 * stays as the user set it, so a change from chat never widens what a run may do.
 */
export function applyRoutineUpdate(current: Routine, params: UpdateRoutineParams): RoutineInput {
  const { cron, at } = params;
  if (cron !== undefined && at !== undefined) throw new Error("give cron or at, not both");
  const schedule: RoutineSchedule = cron !== undefined ? { kind: "cron", exprs: [cron] }
    : at !== undefined ? { kind: "once", at } : current.schedule;
  return parseRoutineInput({
    name: params.name ?? current.name,
    prompt: params.instructions ?? current.prompt,
    enabled: params.enabled ?? current.enabled,
    schedule,
    target: current.target,
    timeoutMinutes: current.timeoutMinutes,
  });
}

/** What an update changed, in words for the tool result ("schedule: Every hour → Every day at 09:00 AM"). */
export function describeRoutineChanges(before: RoutineInput, after: RoutineInput): string[] {
  const changes: string[] = [];
  if (before.name !== after.name) changes.push(`renamed from "${before.name}"`);
  if (before.prompt !== after.prompt) changes.push("instructions replaced");
  const schedule = (input: RoutineInput) => describeSchedule(input.schedule, "en", en);
  if (JSON.stringify(before.schedule) !== JSON.stringify(after.schedule)) changes.push(`schedule: ${schedule(before)} → ${schedule(after)}`);
  if (before.enabled !== after.enabled) changes.push(after.enabled ? "resumed" : "paused");
  return changes;
}

const localTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString("sv-SE").slice(0, 16) : "-");
const serverNow = () => `${localTime(new Date().toISOString())} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;

function runsIn(routine: Routine, chatId: string): string {
  if (routine.target.kind === "new_session") return "a new chat each run";
  if (!routine.target.sessionId) return "a chat its first run creates";
  return routine.target.sessionId === chatId ? "this chat" : `chat ${routine.target.sessionId}`;
}

/** One run: when it was due, when it started, how it ended (a late start shows as the gap). */
export function describeRun(run: RoutineRun): string {
  const due = run.trigger === "manual" ? "manual run" : `due ${localTime(run.scheduledFor)}${run.trigger === "catch_up" ? " (catch-up)" : ""}`;
  const error = run.error ? `: ${run.error.length > 300 ? `${run.error.slice(0, 300)}…` : run.error}` : "";
  return `${due}, started ${localTime(run.startedAt)}, ${run.status}${run.skipReason ? ` (${run.skipReason})` : ""}${error}${run.sessionId ? ` [chat ${run.sessionId}]` : ""}`;
}

/** The list (one line each) or, for one routine, its instructions and recent runs. */
export function describeRoutines(routines: Routine[], chatId: string, now: Date, detailed: boolean): string {
  if (routines.length === 0) return `No routines in this project. Server time now: ${serverNow()}.`;
  const lines = routines.map((routine) => {
    const last = routine.runs[0];
    const head = `- ${routine.id} "${routine.name}" · ${routine.enabled ? "on" : "paused"} · ${describeSchedule(routine.schedule, "en", en)} · next ${nextRunText(routine, now)} · runs in ${runsIn(routine, chatId)} · last run: ${last ? describeRun(last) : "none yet"}`;
    if (!detailed) return head;
    return [
      head,
      `Timeout: ${routine.timeoutMinutes} min.`,
      "Instructions:",
      routine.prompt,
      "Recent runs, newest first:",
      ...(routine.runs.length ? routine.runs.slice(0, 10).map((run) => `- ${describeRun(run)}`) : ["- none yet"]),
    ].join("\n");
  });
  return [...lines, "", `Server time now: ${serverNow()}. Times are the server's local time.`].join("\n");
}

/** Routines belong to a project; a chat sees and changes those of its own project (worktrees included). */
async function inProject(routine: Routine, cwd: string): Promise<boolean> {
  const [theirs, ours] = await Promise.all([resolveProject(routine.target.cwd), resolveProject(cwd)]);
  return samePath(theirs.projectRoot, ours.projectRoot);
}

/**
 * Whether this chat gets the routines tools: the feature is on and its project has not switched
 * them off. An unreadable routines file must not take the tools away; creating reports the real error.
 */
function toolsEnabled(store: () => RoutineStore, projectRoot?: string): boolean {
  try {
    return projectRoot ? store().projectState(projectRoot).enabled : store().isFeatureEnabled();
  } catch {
    return true;
  }
}

/**
 * Pi Web's routines tools, plain host tools like `generate_image`: declared while the feature
 * (and the project's switch) is on, absent otherwise. `model-only`: they ask for approval or end
 * the turn, so codemode scripts must not call them. Nothing is saved before the user confirms in
 * the web UI. Design: docs/routines.md ("Create from chat").
 */
export function createRoutineToolExtension(
  store: () => RoutineStore = () => new RoutineStore(),
  projectRoot?: string,
): InlineExtension {
  return {
    name: "pi-web-routines",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      // Switched off: no tools. A session started before the switch keeps them until reloaded,
      // so execute() checks again.
      if (!toolsEnabled(store, projectRoot)) return;
      const enabledNow = () => toolsEnabled(store, projectRoot);
      const OFF = "Routines are turned off in Pi Web settings.";
      pi.registerTool({
        name: ROUTINE_TOOL_NAME,
        label: "Create routine",
        exposure: "model-only",
        description: [
          "Create a Pi Web routine: instructions run later or repeatedly in this project. The user approves it before it is saved.",
          `Steps: 1) settle choices that change the result (ask with ${ASK_USER_TOOL_NAME} if you cannot); 2) do one trial run now with the exact method the routine will use, then end your turn showing the user its result (skip for plain reminders); 3) once they agree, create it, writing the verified method into instructions: sources, tools, filters, output format, how to skip what was already reported, what to report when blocked. To change a routine use ${ROUTINES_TOOL_NAME}, never a second one.`,
          "run_in: new_chat starts each run fresh, without this conversation, so instructions must be self-contained; this_chat continues this chat (ongoing work). Times are server local time.",
        ].join("\n"),
        parameters: Type.Object({
          name: Type.String({ description: "Short title." }),
          instructions: Type.String({ description: "Sent as the user message on every run." }),
          run_in: StringEnum(["new_chat", "this_chat"]),
          cron: Type.Optional(Type.String({ description: "Repeating: one 5-field cron, e.g. \"0 9 * * 1-5\"." })),
          at: Type.Optional(Type.String({ description: "Or once: YYYY-MM-DDTHH:mm." })),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const now = new Date();
          const fail = (message: string) => ({
            content: [{ type: "text" as const, text: `Not created: ${message}\nServer time now: ${new Date().toLocaleString("sv-SE").slice(0, 16)} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).` }],
            details: { created: false },
          });
          if (!enabledNow()) return fail(OFF);
          let input: RoutineInput;
          try {
            input = routineInputFromToolParams(params as RoutineToolParams, {
              sessionId: ctx.sessionManager.getSessionId(),
              cwd: ctx.cwd,
              ...(ctx.model ? { model: { provider: ctx.model.provider, modelId: ctx.model.id } } : {}),
              thinkingLevel: pi.getThinkingLevel(),
              toolNames: readSessionToolSelection(ctx.sessionManager.getEntries() as unknown as SessionEntry[]),
            });
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
          const schedulerOn = isRoutineSchedulerEnabled();
          let approved: boolean;
          try {
            const [next] = nextRuns(input.schedule, undefined, 1, now);
            const card: RoutineApprovalCard = {
              kind: "routine",
              name: input.name,
              schedule: input.schedule,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              nextRunAt: next?.toISOString() ?? null,
              runIn: input.target.kind === "same_session" ? "this_chat" : "new_chat",
              instructions: input.prompt,
              schedulerOn,
            };
            // Pi Web renders `piWebCard` as its own card, in the browser's language; the
            // markdown message is the fallback for any other client of the extension UI.
            approved = await ctx.ui.confirm(`Create routine "${input.name}"?`, routineConfirmMessage(input, now, schedulerOn), { timeout: CONFIRM_TIMEOUT_MS, signal, piWebCard: card } as Parameters<typeof ctx.ui.confirm>[2]);
          } catch {
            approved = false; // aborted
          }
          if (!approved) return fail("the user declined. Ask what to change before trying again.");
          // The switch may have been turned off while the card waited.
          if (!enabledNow()) return fail(OFF);
          // The answer may come minutes later: a one-time run due meanwhile would never fire.
          try { validateSchedule(input.schedule, minIntervalMs(input.target.kind), true, new Date()); }
          catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
          const routine = await store().create(input);
          const text = [
            `Created routine "${routine.name}". Next run: ${nextRunText(routine, new Date())}. Change it later with ${ROUTINES_TOOL_NAME}.`,
            ...(schedulerOn ? [] : ["Scheduling is off in this Pi Web process, so it runs only when the user clicks Run now."]),
          ].join("\n");
          return { content: [{ type: "text" as const, text }], details: { created: true, routineId: routine.id } };
        },
      });
      registerAskUserTool(pi, enabledNow);
      pi.registerTool({
        name: ROUTINES_TOOL_NAME,
        label: "Routines",
        exposure: "model-only",
        description: "List this project's routines: id, schedule, next and last run. With id: also its instructions and recent runs (due vs start time, status, error), to explain a late or failed run. With id and any of name, instructions, cron, at, enabled: change that routine when the user asks or a run shows it is wrong (instructions replaces the whole text; cron or at replaces the whole schedule). Changes apply without approval, so tell the user what changed. Project, chat, model and tools change on the Routines page only.",
        parameters: Type.Object({
          id: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          instructions: Type.Optional(Type.String()),
          cron: Type.Optional(Type.String({ description: "New repeating schedule (5-field cron)." })),
          at: Type.Optional(Type.String({ description: "Or once: YYYY-MM-DDTHH:mm." })),
          enabled: Type.Optional(Type.Boolean({ description: "false pauses, true resumes." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          // Some models fill every optional field with "": a blank field means "unchanged", like create_routine's cron/at.
          const given = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== "")) as Partial<UpdateRoutineParams>;
          const changing = UPDATE_FIELDS.some((key) => given[key] !== undefined);
          if (!changing) {
            const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });
            if (!enabledNow()) return text(OFF);
            const all = store().list().filter((routine) => !given.id || routine.id === given.id);
            const mine = (await Promise.all(all.map(async (routine) => (await inProject(routine, ctx.cwd) ? routine : null))))
              .filter((routine): routine is Routine => routine !== null);
            if (given.id && mine.length === 0) return text(`No routine ${given.id} in this project.`);
            return text(describeRoutines(mine, ctx.sessionManager.getSessionId(), new Date(), Boolean(given.id)));
          }
          const fail = (message: string) => ({
            content: [{ type: "text" as const, text: `Not updated: ${message}\nServer time now: ${serverNow()}.` }],
            details: { updated: false },
          });
          if (!enabledNow()) return fail(OFF);
          if (!given.id) return fail("give the id of the routine to change; call without fields to list them.");
          // A routine run is unattended work: a read-only chat must not rewrite one without approval.
          if (!hasWriteCapableTool(pi.getActiveTools())) return fail("this chat uses read-only tools. The user can change routines on the Routines page.");
          const change = given as UpdateRoutineParams;
          const before = store().list().find((routine) => routine.id === change.id);
          if (!before || !(await inProject(before, ctx.cwd))) return fail(`no routine ${change.id} in this project; call ${ROUTINES_TOOL_NAME} without fields to list them.`);
          let after: Routine;
          try {
            after = structuredClone(await store().update(change.id, (current) => applyRoutineUpdate(current, change)));
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
          const changes = describeRoutineChanges(before, after);
          if (changes.length === 0) {
            return { content: [{ type: "text" as const, text: `No change: "${after.name}" already has these values.` }], details: { updated: false } };
          }
          const text = `Updated routine "${after.name}": ${changes.join("; ")}. Next run: ${nextRunText(after, new Date())}.`;
          return { content: [{ type: "text" as const, text }], details: { updated: true, routineId: after.id, name: after.name } };
        },
      });
    },
  };
}
