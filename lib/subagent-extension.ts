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
  maxTurns?: number;
  inheritContext?: boolean;
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
}

export interface SubagentExtensionRuntime {
  start(request: StartSubagentRequest): Promise<SubagentExecution>;
  resume(request: ResumeSubagentRequest): Promise<SubagentExecution>;
  get(parentSessionId: string, sessionId: string): Promise<SubagentRunInfo | null>;
  steer(parentSessionId: string, sessionId: string, message: string): Promise<void>;
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
    return `- ${profile.name}: ${profile.description} (${details.join("; ")})`;
  }).join("\n");
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

export function subagentFinalText(run: SubagentRunInfo): string {
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
        const models = subagentModelChoices(ctx.scopedModels, ctx.modelRegistry.getAvailable());
        if (models.length > 0) event.systemPromptOptions.sections.subagent_models = subagentModelsSection(models);
      });
      pi.registerTool(defineTool({
        name: "Agent",
        exposure: "model-only",
        label: "Agent",
        description: `Delegate a focused task to a configured subagent. Each subagent runs as a full, inspectable Pi session. Background is the default: the call returns immediately, and unread results notify the parent after its current run settles. Use foreground mode when no useful work can continue without the result.\n\nAvailable agent types:\n${agentTypeDescription(profiles)}`,
        promptSnippet: "Delegate a focused task to an inspectable subagent session",
        promptGuidelines: [
          "Use Agent for a focused task that benefits from an isolated context.",
          "Use multiple background Agent calls in the same response for independent parallel work.",
          "Use foreground Agent calls when the next action cannot proceed without their results.",
          "After useful parallel work is done, use get_subagent_result with wait=true once as the join point; do not repeatedly poll background agents.",
          "Pass resume with an existing subagent session ID to continue that session instead of creating a new one.",
          "Do not duplicate work already delegated to a running subagent.",
        ],
        executionMode: "parallel",
        parameters: Type.Object({
          subagent_type: Type.Optional(Type.String({ description: `Configured agent profile. Available types: ${availableTypes}. ${profileNames.includes("general-purpose") ? "Default: general-purpose." : "Required: general-purpose is disabled."}` })),
          prompt: Type.String({ description: "The complete task for the subagent." }),
          resume: Type.Optional(Type.String({ description: "Existing subagent session ID to continue. Keeps its model, thinking, tools, context, isolation and turn limit; omit create-only options." })),
          input_files: Type.Optional(Type.Array(Type.String(), {
            description: "UTF-8 text files under the session cwd to include with a new task. With resume, omit or pass [].",
            maxItems: MAX_SUBAGENT_INPUT_FILES,
          })),
          description: Type.String({ description: "Short activity label shown in the UI." }),
          run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately. Default true. Unread results notify the parent after its current run settles." })),
          model: Type.Optional(Type.String({ description: "Exact provider/modelId from <subagent_models>. Omit to use the profile's default model; pass only when the user asks for a model. New sessions only; omit with resume." })),
          thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh, or max. Omit to use the profile's default thinking; pass only when the user asks for a level. New sessions only; omit with resume." })),
          max_turns: Type.Optional(Type.Number({ description: "Optional positive agent turn limit for a new session. With resume, omit or pass 0 to keep the existing limit." })),
          inherit_context: Type.Optional(Type.Boolean({ description: "Include the parent session's active conversation context in a new session. With resume, omit or pass false." })),
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
              params.max_turns !== undefined && params.max_turns !== 0 ? "max_turns" : undefined,
              params.inherit_context === true ? "inherit_context" : undefined,
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
            ...(params.max_turns ? { maxTurns: params.max_turns } : {}),
            ...(params.inherit_context !== undefined ? { inheritContext: params.inherit_context } : {}),
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
              content: [{ type: "text", text: `Subagent started in background. Session ID: ${execution.run.sessionId}. Use get_subagent_result to check it later.` }],
              details: subagentToolDetails(execution.run),
            };
          }

          const run = await execution.completion;
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
        description: "Check an inspectable subagent session and retrieve its latest result.",
        parameters: Type.Object({
          agent_id: Type.String({ description: "Subagent session ID." }),
          wait: Type.Optional(Type.Boolean({ description: "Wait until the subagent finishes." })),
          timeout_ms: Type.Optional(Type.Number({
            description: "Maximum wait in milliseconds. Default: 300000.",
            minimum: 1,
            maximum: 30 * 60_000,
          })),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const parentSessionId = ctx.sessionManager.getSessionId();
          let run = await runtime.get(parentSessionId, params.agent_id);
          if (!run) throw notFound(ctx, params.agent_id);
          const timeoutMs = params.timeout_ms ?? DEFAULT_RESULT_WAIT_TIMEOUT_MS;
          const deadline = Date.now() + timeoutMs;
          while (params.wait && (run.status === "starting" || run.status === "queued" || run.status === "running")) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
              return {
                content: [{ type: "text", text: `Subagent ${run.sessionId} is still ${run.status} after waiting ${timeoutMs}ms.` }],
                details: subagentToolDetails(run),
              };
            }
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                clearTimeout(timer);
                reject(new Error("Result wait aborted"));
              };
              const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
              }, Math.min(500, remainingMs));
              if (signal?.aborted) onAbort();
              else signal?.addEventListener("abort", onAbort, { once: true });
            });
            run = await runtime.get(parentSessionId, params.agent_id);
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
