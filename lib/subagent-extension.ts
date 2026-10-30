import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionContext,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_CONTROL_TOOL_NAMES,
  subagentNotFoundMessage,
  type SubagentProfile,
  type SubagentRunInfo,
} from "./subagents";
import type { SessionEntry } from "./types";
import { MAX_SUBAGENT_INPUT_FILES } from "./subagent-input";

export const HOST_SUBAGENT_EXTENSION_NAME = "pi-web-subagents";
const HOST_SUBAGENT_EXTENSION_PATH = `<inline:${HOST_SUBAGENT_EXTENSION_NAME}>`;
const SUBAGENT_TOOL_NAMES = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
const LEGACY_SUBAGENT_PACKAGE_NAME = "pi-subagents";
const DEFAULT_RESULT_WAIT_TIMEOUT_MS = 5 * 60_000;
const MAX_WAIT_TIMEOUT_MS = 30 * 60_000;
// Foreground means the parent needs the result, so only a stuck child should hit this.
const DEFAULT_FOREGROUND_WAIT_TIMEOUT_MS = MAX_WAIT_TIMEOUT_MS;
const WAIT_TIMEOUT = Symbol("subagent-wait-timeout");
const waitTimeoutParameter = (defaultMs: number) => Type.Optional(Type.Number({
  description: `Maximum wait in milliseconds. Default: ${defaultMs}; maximum: ${MAX_WAIT_TIMEOUT_MS}. A timeout does not stop the subagent.`,
  minimum: 1,
  maximum: MAX_WAIT_TIMEOUT_MS,
}));

async function waitWithinBudget<T>(work: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T | typeof WAIT_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof WAIT_TIMEOUT>((resolve, reject) => {
        timer = setTimeout(() => resolve(WAIT_TIMEOUT), Math.max(0, deadline - Date.now()));
        onAbort = () => reject(new Error("Result wait aborted"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export interface SubagentToolDetails {
  kind: "pi-web-subagent";
  sessionId: string;
  parentToolCallId: string;
  profile: string;
  description: string;
  status: SubagentRunInfo["status"];
  runInBackground: boolean;
  createdAt: string;
  completedAt?: string;
  wrappedAtTurnLimit?: boolean;
  error?: string;
}

export interface StartSubagentRequest {
  parentContext: Pick<ExtensionContext, "sessionManager">;
  parentToolCallId: string;
  profile: string;
  task: string;
  inputFiles?: string[];
  description: string;
  runInBackground?: boolean;
  model?: string;
  thinking?: string;
  isolation?: "worktree";
  signal?: AbortSignal;
  onUpdate?: (run: SubagentRunInfo) => void;
}

export interface ResumeSubagentRequest {
  parentContext: Pick<ExtensionContext, "sessionManager">;
  parentToolCallId: string;
  sessionId: string;
  task: string;
  description: string;
  runInBackground?: boolean;
  signal?: AbortSignal;
  onUpdate?: (run: SubagentRunInfo) => void;
}

export interface SubagentExecution {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  /** Stop linking parent cancellation and deliver the unread result via its wave. */
  deferResult(): void;
}

export interface SubagentExtensionRuntime {
  start(request: StartSubagentRequest): Promise<SubagentExecution>;
  resume(request: ResumeSubagentRequest): Promise<SubagentExecution>;
  get(parentSessionId: string, sessionId: string): Promise<SubagentRunInfo | null>;
  steer(parentSessionId: string, sessionId: string, message: string): Promise<void>;
  /** Stops a run and resolves with its settled (or, past the wait, current) state. */
  abort(parentSessionId: string, sessionId: string): Promise<{ run: SubagentRunInfo; alreadySettled: boolean }>;
  consume(parentSessionId: string, run: SubagentRunInfo): boolean;
}

export type SubagentProfileProvider = () => readonly SubagentProfile[];
export type SubagentEnabledProvider = () => boolean;

function agentTypeDescription(profiles: readonly SubagentProfile[]): string {
  const available = profiles.filter((profile) => profile.enabled);
  if (available.length === 0) return "No subagent profiles are currently enabled.";
  return available.map((profile) => {
    const details = [`Tools: ${profile.tools.length > 0 ? profile.tools.join(", ") : "none"}`];
    if (profile.model) details.push(`Default model: ${profile.model}`);
    if (profile.thinking) details.push(`Default thinking: ${profile.thinking}`);
    details.push(`Parent context: ${profile.inheritContext ? "chat text" : "none"}`);
    return `- ${profile.name}: ${profile.description} (${details.join("; ")})`;
  }).join("\n");
}

/**
 * Delegation policy, rendered by pi as its own `<delegation>` section instead of bullets in the
 * shared `<rules>` list. Deliberately moderate: single lookups stay with the parent, and parallel
 * edits need disjoint files or a worktree.
 */
export function subagentDelegationSection(profiles: readonly SubagentProfile[]): string {
  const names = profiles.filter((profile) => profile.enabled).map((profile) => profile.name);
  const rules = [
    "Agent runs a task in a fresh session that does not see this conversation (unless its profile says `Parent context: chat text`): put the goal, known paths and constraints in the prompt.",
    "Delegate work that needs many reads, long independent effort, or can run in parallel. Do single lookups (one grep or read) yourself.",
  ];
  if (names.includes("explore")) rules.push("`explore`: broad questions about existing code, such as how a flow works or which files touch a feature.");
  if (names.includes("plan")) rules.push("`plan`: before a large change spanning many files or steps.");
  rules.push(
    "Use several background Agent calls in one response for independent work. Parallel implementation only on non-overlapping files, or with isolation: \"worktree\".",
    "Use a foreground call when the next step cannot proceed without the result. Foreground waits use timeout_ms (default and maximum 30 minutes); on timeout the child continues and its unread result is delivered automatically.",
    "Unread background results are delivered automatically after your current run settles. Call get_subagent_result with wait=true once only to join within this run; never poll.",
    "Continue a subagent with resume instead of starting a new one, and do not duplicate work already delegated.",
    "Use abort_subagent to stop a subagent whose task became obsolete or is going wrong.",
  );
  const others = names.filter((name) => name !== "explore" && name !== "plan");
  if (others.length > 0) rules.push(`Other subagents: ${others.map((name) => `\`${name}\``).join(", ")}.`);
  return rules.map((rule) => `- ${rule}`).join("\n");
}

/** Models an agent may pass as `model`: the session's `enabledModels` scope, else every model with auth. */
export function subagentModelChoices<T extends { provider: string; id: string }>(
  scoped: ReadonlyArray<{ model: T }>,
  available: readonly T[],
): readonly T[] {
  return scoped.length > 0 ? scoped.map((entry) => entry.model) : available;
}

const MAX_LISTED_MODELS = 40;

/** System prompt section naming the models the Agent tool accepts, so a user's model choice is never guessed. */
export function subagentModelsSection(models: ReadonlyArray<{ provider: string; id: string; name?: string }>): string {
  const listed = models.slice(0, MAX_LISTED_MODELS).map((model) => (
    `- ${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}`
  ));
  if (models.length > MAX_LISTED_MODELS) {
    listed.push(`- ...${models.length - MAX_LISTED_MODELS} more; an exact provider/modelId the user gives is also accepted`);
  }
  return [
    "Models for the Agent tool's `model` parameter. When the user names one, pass its provider/modelId; pass any effort level (e.g. \"medium\") as `thinking`.",
    ...listed,
  ].join("\n");
}

export function subagentToolDetails(run: SubagentRunInfo): SubagentToolDetails {
  return {
    kind: "pi-web-subagent",
    sessionId: run.sessionId,
    parentToolCallId: run.parentToolCallId,
    profile: run.profile,
    description: run.description,
    status: run.status,
    runInBackground: run.runInBackground,
    createdAt: run.createdAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.wrappedAtTurnLimit ? { wrappedAtTurnLimit: true } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

export function subagentWorktreeText(run: SubagentRunInfo): string {
  if (run.worktreeCleanup === "missing") {
    return "[Isolated worktree: checkout already missing; change state unknown. Check repository branches for commits.]";
  }
  if (run.worktreeCleanup === "removed") {
    return run.worktreeBranch
      ? `[Isolated worktree: changes committed to branch ${run.worktreeBranch}; checkout removed.]`
      : "[Isolated worktree: no changes; checkout removed.]";
  }
  if (run.worktreeCleanup === "kept" && run.worktreePath) {
    // Only host-authored summaries are safe; raw git errors can recommend destructive commands.
    const reason = [
      "Could not inspect checkout changes.",
      "Could not commit checkout changes.",
      "Could not preserve commits on a branch.",
      "Could not remove temporary checkout.",
    ].includes(run.worktreeCleanupError ?? "") ? run.worktreeCleanupError : "Automatic cleanup did not complete.";
    return `[Isolated worktree: cleanup failed; checkout kept at ${run.worktreePath}. ${reason}${run.worktreeBranch ? ` Commits preserved on branch ${run.worktreeBranch}.` : ""}]`;
  }
  return "";
}

export function subagentFinalText(run: SubagentRunInfo): string {
  const text = subagentStatusText(run);
  if (run.status === "starting" || run.status === "running" || run.status === "queued") return text;
  const cleanup = subagentWorktreeText(run);
  return cleanup ? `${cleanup}\n\n${text}` : text;
}

function subagentStatusText(run: SubagentRunInfo): string {
  if (run.status === "starting" || run.status === "running" || run.status === "queued") {
    return `Subagent ${run.sessionId} is ${run.status}.`;
  }
  if (run.status === "completed") {
    const result = run.result?.trim() || "Subagent completed without text output.";
    return run.wrappedAtTurnLimit
      ? `${result}\n\n[Subagent wrapped up after reaching its turn limit.]`
      : result;
  }
  if (run.status === "aborted") {
    return run.result?.trim()
      ? `${run.result.trim()}\n\n[Subagent was stopped before completing normally.]`
      : `Subagent ${run.sessionId} was stopped.`;
  }
  if (run.status === "interrupted") return `Subagent ${run.sessionId} was interrupted before completion.`;
  return run.result?.trim()
    ? `${run.result.trim()}\n\n[Subagent failed: ${run.error ?? "Unknown error"}]`
    : `Subagent ${run.sessionId} failed: ${run.error ?? "Unknown error"}`;
}

export function createSubagentExtension(
  runtime: SubagentExtensionRuntime,
  getProfiles: SubagentProfileProvider,
  isEnabled: SubagentEnabledProvider = () => true,
): InlineExtension {
  return {
    name: HOST_SUBAGENT_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      if (!isEnabled()) return;
      const profiles = getProfiles().filter((profile) => profile.enabled);
      // Nothing to delegate to: expose no tools rather than an Agent that always fails.
      if (profiles.length === 0) return;
      const profileNames = profiles.map((profile) => profile.name);
      const availableTypes = profileNames.length > 0 ? profileNames.join(", ") : "none";
      const notFound = (ctx: ExtensionContext, sessionId: string) =>
        new Error(subagentNotFoundMessage(ctx.sessionManager.getEntries() as unknown as SessionEntry[], sessionId));
      // A failed subagent run is returned with its details (so the card still links
      // to the child session) and flagged here: a thrown error would drop `details`.
      pi.on("tool_result", (event) => {
        if (event.toolName !== "Agent" && event.toolName !== "get_subagent_result") return undefined;
        const details = event.details as Partial<SubagentToolDetails> | undefined;
        return details?.kind === "pi-web-subagent" && details.status === "failed" ? { isError: true } : undefined;
      });
      // Tool descriptions are fixed at load time, before the session's model scope exists, so the list rides in the prompt.
      pi.on("before_agent_start", (event, ctx) => {
        if (!event.systemPromptOptions.selectedTools.includes("Agent")) return;
        event.systemPromptOptions.sections.delegation = subagentDelegationSection(profiles);
        const models = subagentModelChoices(ctx.scopedModels, ctx.modelRegistry.getAvailable());
        if (models.length > 0) event.systemPromptOptions.sections.subagent_models = subagentModelsSection(models);
      });
      pi.registerTool(defineTool({
        name: "Agent",
        exposure: "model-only",
        label: "Agent",
        description: `Delegate a focused task to a configured subagent. Each subagent runs as a full, inspectable Pi session. Background is the default: the call returns immediately, and unread results notify the parent after its current run settles. Use foreground mode when no useful work can continue without the result; timeout_ms bounds that wait (default and maximum 30 minutes), then the child continues and reports automatically.\n\nAvailable agent types:\n${agentTypeDescription(profiles)}`,
        promptSnippet: "Delegate a focused task to an inspectable subagent session; see <delegation> for when",
        executionMode: "parallel",
        parameters: Type.Object({
          subagent_type: Type.Optional(Type.String({ description: `Configured agent profile. Available types: ${availableTypes}. ${profileNames.includes("general-purpose") ? "Default: general-purpose." : "Required: general-purpose is disabled."}` })),
          prompt: Type.String({ description: "The complete task for the subagent." }),
          resume: Type.Optional(Type.String({ description: "Existing subagent session ID to continue. Keeps its model, thinking, tools, context, isolation and turn limit; omit create-only options." })),
          input_files: Type.Optional(Type.Array(Type.String(), {
            description: "UTF-8 text files under the session cwd to include with a new task; their total size is limited to about a quarter of the subagent model's context window. With resume, omit or pass [].",
            maxItems: MAX_SUBAGENT_INPUT_FILES,
          })),
          description: Type.String({ description: "Short activity label shown in the UI." }),
          timeout_ms: waitTimeoutParameter(DEFAULT_FOREGROUND_WAIT_TIMEOUT_MS),
          run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately. Default true. Unread results notify the parent after its current run settles." })),
          model: Type.Optional(Type.String({ description: "Exact provider/modelId from <subagent_models>. Omit to use the profile's default model; pass only when the user asks for a model. New sessions only; omit with resume." })),
          thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh, or max. Omit to use the profile's default thinking; pass only when the user asks for a level. New sessions only; omit with resume." })),
          isolation: Type.Optional(Type.String({ description: "Run a new subagent in an isolated git worktree copy. With resume, omit or pass an empty string to keep existing isolation." })),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const resume = params.resume?.trim();
          if (resume && (params.model || params.thinking)) {
            throw new Error("resume keeps the subagent's model and thinking level; omit model/thinking, or start a new subagent to change them.");
          }
          if (resume) {
            const unsupported = [
              params.input_files?.length ? "input_files" : undefined,
              params.isolation ? "isolation" : undefined,
            ].filter(Boolean);
            if (unsupported.length > 0) {
              throw new Error(`resume cannot override create-only options: ${unsupported.join(", ")}. Omit them, or start a new subagent.`);
            }
          }
          const execution = resume
            ? await runtime.resume({
                parentContext: ctx,
                parentToolCallId: toolCallId,
                sessionId: resume,
                task: params.prompt,
                description: params.description,
                ...(params.run_in_background !== undefined ? { runInBackground: params.run_in_background } : {}),
                signal,
                onUpdate: (run) => onUpdate?.({
                  content: [{ type: "text", text: `${run.profile}: ${run.description} (${run.status})` }],
                  details: subagentToolDetails(run),
                }),
              })
            : await runtime.start({
            parentContext: ctx,
            parentToolCallId: toolCallId,
            profile: params.subagent_type ?? "general-purpose",
            task: params.prompt,
            ...(params.input_files ? { inputFiles: params.input_files } : {}),
            description: params.description,
            ...(params.run_in_background !== undefined ? { runInBackground: params.run_in_background } : {}),
            ...(params.model ? { model: params.model } : {}),
            ...(params.thinking ? { thinking: params.thinking } : {}),
            ...(params.isolation === "worktree" ? { isolation: "worktree" as const } : {}),
            signal,
            onUpdate: (run) => onUpdate?.({
              content: [{ type: "text", text: `${run.profile}: ${run.description} (${run.status})` }],
              details: subagentToolDetails(run),
            }),
          });

          // A background start that already failed (e.g. queue rejection) reports the failure now.
          if (execution.run.runInBackground && execution.run.status !== "failed") {
            void execution.completion.catch((error) => {
              console.error(
                "[pi-web] background subagent failed to settle:",
                error instanceof Error ? error.message : error,
              );
            });
            return {
              content: [{ type: "text", text: `Subagent started in background. Session ID: ${execution.run.sessionId}. Its result will be delivered automatically after your current run settles.` }],
              details: subagentToolDetails(execution.run),
            };
          }

          const run = await waitWithinBudget(execution.completion, Date.now() + (params.timeout_ms ?? DEFAULT_FOREGROUND_WAIT_TIMEOUT_MS), signal);
          if (run === WAIT_TIMEOUT) {
            execution.deferResult();
            return {
              content: [{ type: "text", text: `Wait timed out. Subagent ${execution.run.sessionId} continues in background; its unread result will be delivered automatically after your current run settles. Do not poll.` }],
              details: subagentToolDetails(execution.run),
            };
          }
          // The early background failure is already queued as unread; this result delivers it.
          if (run.runInBackground) runtime.consume(ctx.sessionManager.getSessionId(), run);
          return {
            // details are not model-visible; the ID must be in the text for a later `resume`.
            content: [{ type: "text", text: `${subagentFinalText(run)}\n\n[Subagent session ID: ${run.sessionId} (pass as resume to continue)]` }],
            details: subagentToolDetails(run),
          };
        },
      }));

      pi.registerTool(defineTool({
        name: "get_subagent_result",
        exposure: "model-only",
        label: "Get agent result",
        description: "Retrieve a subagent's result, e.g. to re-read an earlier one. Unread background results are delivered automatically after your current run settles; use wait=true once only to join within this run. timeout_ms bounds the entire lookup and wait; it does not stop the child. Do not poll.",
        parameters: Type.Object({
          agent_id: Type.String({ description: "Subagent session ID." }),
          wait: Type.Optional(Type.Boolean({ description: "Wait until the subagent finishes." })),
          timeout_ms: waitTimeoutParameter(DEFAULT_RESULT_WAIT_TIMEOUT_MS),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const parentSessionId = ctx.sessionManager.getSessionId();
          const timeoutMs = params.timeout_ms ?? DEFAULT_RESULT_WAIT_TIMEOUT_MS;
          const deadline = Date.now() + timeoutMs;
          let run: SubagentRunInfo | null = null;
          const read = () => params.wait
            ? waitWithinBudget(runtime.get(parentSessionId, params.agent_id), deadline, signal)
            : runtime.get(parentSessionId, params.agent_id);
          const timedOut = () => ({
            content: [{ type: "text" as const, text: run
              ? `Subagent ${run.sessionId} is still ${run.status} after waiting ${timeoutMs}ms.`
              : `Timed out waiting ${timeoutMs}ms for subagent ${params.agent_id}. Its result lookup is still pending.` }],
            details: run ? subagentToolDetails(run) : undefined,
          });
          const first = await read();
          if (first === WAIT_TIMEOUT) return timedOut();
          run = first;
          if (!run) throw notFound(ctx, params.agent_id);
          while (params.wait && (run.status === "starting" || run.status === "queued" || run.status === "running")) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) return timedOut();
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                reject(new Error("Result wait aborted"));
              };
              const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
              }, Math.min(500, remainingMs));
              if (signal?.aborted) onAbort();
              else signal?.addEventListener("abort", onAbort, { once: true });
            });
            if (Date.now() >= deadline) return timedOut();
            const next = await read();
            if (next === WAIT_TIMEOUT) return timedOut();
            run = next;
            if (!run) throw new Error(`Subagent not found: ${params.agent_id}`);
          }
          if (run.status !== "starting" && run.status !== "queued" && run.status !== "running") {
            runtime.consume(parentSessionId, run);
          }
          return {
            content: [{ type: "text", text: subagentFinalText(run) }],
            details: subagentToolDetails(run),
          };
        },
      }));

      pi.registerTool(defineTool({
        name: "steer_subagent",
        exposure: "model-only",
        label: "Steer agent",
        description: "Send a steering message to a currently running subagent session.",
        parameters: Type.Object({
          agent_id: Type.String({ description: "Subagent session ID." }),
          message: Type.String({ description: "Instruction to inject after the current tool execution." }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const parentSessionId = ctx.sessionManager.getSessionId();
          await runtime.steer(parentSessionId, params.agent_id, params.message);
          return { content: [{ type: "text", text: `Steering message sent to ${params.agent_id}.` }], details: undefined };
        },
      }));

      pi.registerTool(defineTool({
        name: "abort_subagent",
        exposure: "model-only",
        label: "Stop agent",
        description: "Stop a queued or running subagent you delegated whose task became obsolete or is going wrong. Its transcript stays readable and resumable.",
        parameters: Type.Object({
          agent_id: Type.String({ description: "Subagent session ID." }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const parentSessionId = ctx.sessionManager.getSessionId();
          const { run, alreadySettled } = await runtime.abort(parentSessionId, params.agent_id);
          const settled = run.status !== "starting" && run.status !== "queued" && run.status !== "running";
          // The parent asked for this stop, so it needs no completion notification as well.
          if (settled) runtime.consume(parentSessionId, run);
          const text = alreadySettled
            ? `Subagent ${run.sessionId} already ${run.status}; nothing to stop.`
            : !settled
              ? `Stop requested for subagent ${run.sessionId}; it is still ${run.status}. Its result will be delivered after it settles.`
              : `Subagent ${run.sessionId} stopped (${run.status}). Read its transcript with get_subagent_result or continue it with Agent resume.`;
          return { content: [{ type: "text", text }], details: subagentToolDetails(run) };
        },
      }));
    },
  };
}

/** Keep Pi Web's integrated implementation when the legacy package is loaded. */
export function preferPiWebSubagentExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const host = base.extensions.find((extension) => extension.path === HOST_SUBAGENT_EXTENSION_PATH);
  if (!host?.tools.has("Agent")) return base;
  const legacyPaths = new Set(base.extensions
    .filter((extension) => extension.path !== HOST_SUBAGENT_EXTENSION_PATH)
    .filter((extension) => {
      const source = extension.sourceInfo?.source ?? "";
      const sourcePackage = source.replace(/^npm:/, "").split("@")[0];
      const pathSegments = extension.path.replaceAll("\\", "/").split("/");
      return sourcePackage === LEGACY_SUBAGENT_PACKAGE_NAME
        || pathSegments.some((segment) => segment === LEGACY_SUBAGENT_PACKAGE_NAME);
    })
    .filter((extension) => [...SUBAGENT_TOOL_NAMES].some((name) => extension.tools.has(name)))
    .map((extension) => extension.path));
  if (legacyPaths.size === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !legacyPaths.has(extension.path)),
    errors: base.errors.filter((error) => {
      if (legacyPaths.has(error.path)) return false;
      if (error.path !== HOST_SUBAGENT_EXTENSION_PATH) return true;
      return ![...legacyPaths].some((legacyPath) =>
        [...SUBAGENT_TOOL_NAMES].some((name) =>
          error.error === `Tool "${name}" conflicts with ${legacyPath}`
        )
      );
    }),
  };
}
