import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionContext,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_CONTROL_TOOL_NAMES,
  type SubagentProfile,
  type SubagentRunInfo,
} from "./subagents";
import { MAX_SUBAGENT_INPUT_FILES } from "./subagent-input";

export const HOST_SUBAGENT_EXTENSION_NAME = "pi-web-subagents";
const HOST_SUBAGENT_EXTENSION_PATH = `<inline:${HOST_SUBAGENT_EXTENSION_NAME}>`;
const SUBAGENT_TOOL_NAMES = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
const LEGACY_SUBAGENT_PACKAGE_NAME = "pi-subagents";
const DEFAULT_RESULT_WAIT_TIMEOUT_MS = 5 * 60_000;

export interface SubagentToolDetails {
  kind: "pi-web-subagent";
  sessionId: string;
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
  parentContext: ExtensionContext;
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
  signal?: AbortSignal;
  onUpdate?: (run: SubagentRunInfo) => void;
}

export interface SubagentExecution {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
}

export interface SubagentExtensionRuntime {
  start(request: StartSubagentRequest): Promise<SubagentExecution>;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string): Promise<void>;
}

export type SubagentProfileProvider = () => readonly SubagentProfile[];
export type SubagentEnabledProvider = () => boolean;

function agentTypeDescription(profiles: readonly SubagentProfile[]): string {
  const available = profiles.filter((profile) => profile.enabled);
  if (available.length === 0) return "No subagent profiles are currently enabled.";
  return available.map((profile) => {
    const details = [`Tools: ${profile.tools.length > 0 ? profile.tools.join(", ") : "none"}`];
    if (profile.model) details.push(`Model: ${profile.model}`);
    return `- ${profile.name}: ${profile.description} (${details.join("; ")})`;
  }).join("\n");
}

export function subagentToolDetails(run: SubagentRunInfo): SubagentToolDetails {
  return {
    kind: "pi-web-subagent",
    sessionId: run.sessionId,
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
  if (run.status === "starting" || run.status === "running") {
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
      const profileNames = profiles.map((profile) => profile.name);
      const availableTypes = profileNames.length > 0 ? profileNames.join(", ") : "none";
      pi.registerTool(defineTool({
        name: "Agent",
        label: "Agent",
        description: `Delegate a focused task to a configured subagent. Each subagent runs as a full, inspectable Pi session. Use foreground mode when the current response needs the result. Use background mode only for independent work, then retrieve the result later with get_subagent_result.\n\nAvailable agent types:\n${agentTypeDescription(profiles)}`,
        promptSnippet: "Delegate a focused task to an inspectable subagent session",
        promptGuidelines: [
          "Use Agent for a focused task that benefits from an isolated context.",
          "Use multiple background Agent calls in the same response for independent parallel work.",
          "Use foreground Agent calls when their results are needed before the current response can finish.",
          "Do not duplicate work already delegated to a running subagent.",
        ],
        executionMode: "parallel",
        parameters: Type.Object({
          subagent_type: Type.Optional(Type.String({ description: `Configured agent profile. Available types: ${availableTypes}. Default: general-purpose.` })),
          prompt: Type.String({ description: "The complete task for the subagent." }),
          input_files: Type.Optional(Type.Array(Type.String(), {
            description: "UTF-8 text files under the session cwd to include with the task.",
            maxItems: MAX_SUBAGENT_INPUT_FILES,
          })),
          description: Type.String({ description: "Short activity label shown in the UI." }),
          run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately. Retrieve the result later with get_subagent_result." })),
          model: Type.Optional(Type.String({ description: "Optional provider/modelId override." })),
          thinking: Type.Optional(Type.String({ description: "Optional thinking level override." })),
          max_turns: Type.Optional(Type.Number({ description: "Optional positive agent turn limit." })),
          inherit_context: Type.Optional(Type.Boolean({ description: "Include the parent session's active conversation context." })),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const execution = await runtime.start({
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
            signal,
            onUpdate: (run) => onUpdate?.({
              content: [{ type: "text", text: `${run.profile}: ${run.description} (${run.status})` }],
              details: subagentToolDetails(run),
            }),
          });

          if (execution.run.runInBackground) {
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
          if (run.status === "failed") throw new Error(subagentFinalText(run));
          return {
            content: [{ type: "text", text: subagentFinalText(run) }],
            details: subagentToolDetails(run),
          };
        },
      }));

      pi.registerTool(defineTool({
        name: "get_subagent_result",
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
        async execute(_toolCallId, params, signal) {
          let run = await runtime.get(params.agent_id);
          if (!run) throw new Error(`Subagent not found: ${params.agent_id}`);
          const timeoutMs = params.timeout_ms ?? DEFAULT_RESULT_WAIT_TIMEOUT_MS;
          const deadline = Date.now() + timeoutMs;
          while (params.wait && (run.status === "starting" || run.status === "running")) {
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
            run = await runtime.get(params.agent_id);
            if (!run) throw new Error(`Subagent not found: ${params.agent_id}`);
          }
          if (run.status === "failed") throw new Error(subagentFinalText(run));
          return {
            content: [{ type: "text", text: subagentFinalText(run) }],
            details: subagentToolDetails(run),
          };
        },
      }));

      pi.registerTool(defineTool({
        name: "steer_subagent",
        label: "Steer agent",
        description: "Send a steering message to a currently running subagent session.",
        parameters: Type.Object({
          agent_id: Type.String({ description: "Subagent session ID." }),
          message: Type.String({ description: "Instruction to inject after the current tool execution." }),
        }),
        async execute(_toolCallId, params) {
          await runtime.steer(params.agent_id, params.message);
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
