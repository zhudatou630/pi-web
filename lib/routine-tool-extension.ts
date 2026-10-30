import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { minIntervalMs, nextRuns, type RoutineSchedule } from "./routine-schedule";
import { describeSchedule, type Translate } from "./routine-summary";
import { interpolateMessage } from "./i18n/format";
import { enLocale } from "./i18n/messages/en";
import { parseRoutineInput, RoutineStore, validateSchedule, type RoutineInput } from "./routines";
import { isRoutineSchedulerEnabled } from "./routine-scheduler-flag";
import { readSessionToolSelection } from "./session-tool-selection";
import type { RoutineApprovalCard, SessionEntry } from "./types";

// Design: docs/routines.md ("Create from chat").

export const ROUTINE_TOOL_NAME = "create_routine";
const TOOL_SEARCH = "tool_search";
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

/** An unreadable routines file must not take the tool away; creating reports the real error. */
function featureEnabled(store: () => RoutineStore): boolean {
  try { return store().isFeatureEnabled(); } catch { return true; }
}

/**
 * `create_routine`, loaded on demand: deferred, so only `tool_search` (activated here when
 * Pi Web's tool-search extension is present) and a one-line hint sit in the context until
 * the model asks for scheduling. Nothing is saved before the user confirms in the web UI.
 */
export function createRoutineToolExtension(store: () => RoutineStore = () => new RoutineStore()): InlineExtension {
  return {
    name: "pi-web-routines",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      // Switched off in Settings: no tool, no tool_search activation, no prompt line. A session
      // started before the switch keeps its tool until reloaded, so execute() checks again.
      if (!featureEnabled(store)) return;
      const searchable = () => pi.getAllTools().some((tool) => tool.name === TOOL_SEARCH && tool.reachesTools);
      pi.on("session_start", () => {
        const active = pi.getActiveTools();
        if (searchable() && !active.includes(TOOL_SEARCH)) pi.setActiveTools([...active, TOOL_SEARCH]);
      });
      pi.on("before_agent_start", (event) => {
        if (!event.systemPromptOptions.selectedTools.includes(TOOL_SEARCH)) return;
        event.systemPromptOptions.sections.routines = `To run work later or on a schedule (a Pi Web routine), load \`${ROUTINE_TOOL_NAME}\` with ${TOOL_SEARCH}.`;
      });
      pi.registerTool({
        name: ROUTINE_TOOL_NAME,
        label: "Create routine",
        exposure: "deferred",
        description: [
          "Create a Pi Web routine: instructions that run later or repeatedly in this project. The user approves a summary before it is saved.",
          "run_in: new_chat for independent jobs (digests, scans, reviews); each run starts fresh with no memory of this conversation, so make instructions self-contained (goal, scope, expected output). this_chat for ongoing work that needs this conversation (watching a PR, following up); each run continues here.",
          "Times are the server's local time. Runs must be at least 15 minutes apart (5 for this_chat).",
        ].join("\n"),
        parameters: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 80, description: "Short title." }),
          instructions: Type.String({ minLength: 1, maxLength: 20_000, description: "Sent as the user message on every run." }),
          run_in: StringEnum(["new_chat", "this_chat"]),
          cron: Type.Optional(Type.String({ description: "Repeating: one 5-field cron, e.g. \"0 9 * * 1-5\" or \"*/30 * * * *\" (steps must divide the hour or day)." })),
          at: Type.Optional(Type.String({ description: "Once: YYYY-MM-DDTHH:mm. Give cron or at, not both." })),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const now = new Date();
          const fail = (message: string) => ({
            content: [{ type: "text" as const, text: `Not created: ${message}\nServer time now: ${new Date().toLocaleString("sv-SE").slice(0, 16)} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).` }],
            details: { created: false },
          });
          if (!featureEnabled(store)) return fail("Routines are turned off in Pi Web settings.");
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
          // The answer may come minutes later: a one-time run due meanwhile would never fire.
          try { validateSchedule(input.schedule, minIntervalMs(input.target.kind), true, new Date()); }
          catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
          const routine = await store().create(input);
          const text = [
            `Created routine "${routine.name}". Next run: ${nextRunText(routine, new Date())}. It is managed on the Routines page.`,
            ...(schedulerOn ? [] : ["Scheduling is off in this Pi Web process, so it runs only when the user clicks Run now."]),
          ].join("\n");
          return { content: [{ type: "text" as const, text }], details: { created: true, routineId: routine.id } };
        },
      });
    },
  };
}
