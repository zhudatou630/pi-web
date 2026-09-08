import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "./pi-types";
import {
  type StartSubagentRequest,
  type SubagentExecution,
  type SubagentExtensionRuntime,
} from "./subagent-extension";
import {
  readSubagentRun,
  resolveSubagentProfile,
  SUBAGENT_CONTROL_TOOL_NAMES,
  SUBAGENT_META_TYPE,
  SUBAGENT_RESULT_TYPE,
  withSubagentExtensionTools,
  type SubagentMetadata,
  type SubagentProfile,
  type SubagentResultMetadata,
  type SubagentRunInfo,
} from "./subagents";
import type { SessionEntry } from "./types";
import { buildSubagentPromptPlan } from "./subagent-prompt";
import { appendSubagentInputFiles, loadSubagentInputFiles } from "./subagent-input";
import { projectTrustReloadOptions } from "./project-trust";
import { resolveShellTools } from "./powershell-settings";
import { isBuiltInSubagentsEnabled } from "./subagent-settings";
import { contextFilesSystemPrompt, type ContextFileContent } from "./chat-only";

interface HostSession {
  readonly inner: AgentSessionLike;
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
}

export interface SubagentRuntimeDependencies {
  getSession(sessionId: string): HostSession | undefined;
  registerSession(
    inner: AgentSessionLike,
    options?: { exactSystemPrompt?: string; chatOnly?: boolean },
  ): void;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  invalidateSessionList(): void;
  isBuiltInSubagentsEnabled?(): boolean;
}

export interface SubagentController {
  readonly extensionRuntime: SubagentExtensionRuntime;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
};

declare global {
  var __piSubagentRuns: Map<string, StoredSubagentExecution> | undefined;
  var __piSubagentStartingCounts: Map<string, number> | undefined;
}

const MAX_CONCURRENT_SUBAGENTS = 8;
const SUBAGENT_CONTEXT_LIMIT = 50_000;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface SubagentOutcome {
  status: "completed" | "failed" | "aborted";
  wrappedAtTurnLimit?: boolean;
  result?: string;
  error?: string;
}

interface SubagentTurnLimitState {
  turnCount: number;
  wrapUpRequested: boolean;
  turnLimitReached: boolean;
}

export function advanceSubagentTurnLimit(
  state: SubagentTurnLimitState,
  message: AgentMessage,
  turnLimit: number,
): { state: SubagentTurnLimitState; requestWrapUp: boolean } {
  const turnCount = state.turnCount + 1;
  const hasToolCalls = message.role === "assistant"
    && message.content.some((block) => block.type === "toolCall");
  if (!state.wrapUpRequested && turnCount >= turnLimit && hasToolCalls) {
    return {
      state: { turnCount, wrapUpRequested: true, turnLimitReached: false },
      requestWrapUp: true,
    };
  }
  return {
    state: {
      turnCount,
      wrapUpRequested: state.wrapUpRequested,
      turnLimitReached: state.wrapUpRequested && turnCount >= turnLimit + 1,
    },
    requestWrapUp: false,
  };
}

function messageText(message: AgentMessage | undefined): string | undefined {
  if (message?.role !== "assistant") return undefined;
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  return text || undefined;
}

export function deriveSubagentOutcome(
  messages: readonly AgentMessage[],
  options: { abortRequested: boolean; turnLimitReached: boolean; thrownError?: string },
): SubagentOutcome {
  const assistants = messages.filter((message) => message.role === "assistant");
  const lastAssistant = assistants.at(-1);
  const result = [...assistants].reverse().map(messageText).find(Boolean);
  const stopReason = lastAssistant?.role === "assistant" ? lastAssistant.stopReason : undefined;
  const terminalError = lastAssistant?.role === "assistant" ? lastAssistant.errorMessage?.trim() : undefined;
  const terminalHasToolCalls = lastAssistant?.role === "assistant"
    && lastAssistant.content.some((block) => block.type === "toolCall");

  if (options.abortRequested || stopReason === "aborted") {
    return { status: "aborted", ...(result ? { result } : {}) };
  }
  if (stopReason === "error") {
    return {
      status: "failed",
      ...(result ? { result } : {}),
      error: terminalError || options.thrownError || "Subagent model request failed",
    };
  }
  if (stopReason === "length") {
    return {
      status: "failed",
      ...(result ? { result } : {}),
      error: "Subagent response reached its output limit",
    };
  }
  if (options.thrownError) {
    return { status: "failed", ...(result ? { result } : {}), error: options.thrownError };
  }
  if (options.turnLimitReached && (terminalHasToolCalls || !messageText(lastAssistant))) {
    return {
      status: "failed",
      ...(result ? { result } : {}),
      error: "Subagent reached its turn limit before producing a final response",
    };
  }
  return result
    ? {
        status: "completed",
        ...(options.turnLimitReached ? { wrappedAtTurnLimit: true } : {}),
        result,
      }
    : { status: "failed", error: "Subagent completed without text output" };
}

function getSubagentRuns(): Map<string, StoredSubagentExecution> {
  if (!globalThis.__piSubagentRuns) globalThis.__piSubagentRuns = new Map();
  return globalThis.__piSubagentRuns;
}

function getSubagentStartingCounts(): Map<string, number> {
  if (!globalThis.__piSubagentStartingCounts) globalThis.__piSubagentStartingCounts = new Map();
  return globalThis.__piSubagentStartingCounts;
}

function parseSubagentModel(runtime: ModelRuntime, value: string | undefined) {
  if (!value?.trim()) return undefined;
  const requested = value.trim();
  const slash = requested.indexOf("/");
  if (slash > 0) {
    const provider = requested.slice(0, slash);
    const modelId = requested.slice(slash + 1);
    const model = runtime.getModel(provider, modelId);
    if (!model) throw new Error(`Subagent model not found: ${requested}`);
    return model;
  }
  const matches = runtime.getModels().filter((model) => model.id === requested);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`Subagent model not found: ${requested}`);
  throw new Error(`Subagent model is ambiguous; use provider/modelId: ${requested}`);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      typeof block === "object"
      && block !== null
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function buildParentContextText(
  messages: readonly AgentMessage[],
  limitBytes = SUBAGENT_CONTEXT_LIMIT,
): string {
  const sections = messages.flatMap((message) => {
    if (message.role === "user" || message.role === "assistant") {
      const text = contentText(message.content);
      return text ? [`[${message.role === "user" ? "User" : "Assistant"}]\n${text}`] : [];
    }
    if (message.role === "compactionSummary") {
      const summary = message.summary.trim();
      return summary ? [`[Summary]\n${summary}`] : [];
    }
    return [];
  });

  const allContext = sections.join("\n\n");
  if (Buffer.byteLength(allContext, "utf8") <= limitBytes) return allContext;

  const omission = "[Earlier parent context omitted]";
  const omissionBytes = Buffer.byteLength(omission, "utf8");
  if (limitBytes < omissionBytes) return "";
  const availableBytes = limitBytes - omissionBytes - 2;
  const selected: string[] = [];
  let bytes = 0;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    const addedBytes = Buffer.byteLength(section, "utf8") + (selected.length > 0 ? 2 : 0);
    if (bytes + addedBytes > availableBytes) break;
    selected.push(section);
    bytes += addedBytes;
  }
  selected.reverse();
  return [omission, ...selected].join("\n\n");
}

function parentContextText(parent: HostSession): string {
  return buildParentContextText(parent.inner.sessionManager.buildSessionContext().messages);
}

export function projectInstructionsForSubagent(
  profile: Pick<SubagentProfile, "name" | "scope">,
  files: readonly ContextFileContent[],
): string | undefined {
  if (profile.scope !== "builtin" || profile.name !== "general-purpose") return undefined;
  return contextFilesSystemPrompt(files).trim() || undefined;
}

function reserveSubagentSlot(parentSessionId: string): () => void {
  const starting = getSubagentStartingCounts();
  const active = [...getSubagentRuns().values()].filter((item) =>
    item.run.parentSessionId === parentSessionId
      && (item.run.status === "starting" || item.run.status === "running")
  ).length;
  const startingCount = starting.get(parentSessionId) ?? 0;
  if (active + startingCount >= MAX_CONCURRENT_SUBAGENTS) {
    throw new Error(`A session can run at most ${MAX_CONCURRENT_SUBAGENTS} subagents at once`);
  }
  starting.set(parentSessionId, startingCount + 1);
  return () => {
    const remaining = (starting.get(parentSessionId) ?? 1) - 1;
    if (remaining > 0) starting.set(parentSessionId, remaining);
    else starting.delete(parentSessionId);
  };
}

export function createSubagentController(
  dependencies: SubagentRuntimeDependencies,
): SubagentController {
  async function start(request: StartSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    if (!parent.sessionFile) throw new Error("Parent session must be persisted before starting a subagent");

    const releaseSlot = reserveSubagentSlot(parentSessionId);
    try {
      const profile = resolveSubagentProfile(parent.cwd, request.profile);
      if (!profile) throw new Error(`Unknown or disabled subagent profile: ${request.profile}`);

      const runInBackground = request.runInBackground ?? profile.runInBackground;
      const inheritContext = request.inheritContext ?? profile.inheritContext;
      const maxTurns = request.maxTurns ?? profile.maxTurns;
      if (maxTurns !== undefined && (!Number.isFinite(maxTurns) || maxTurns < 0)) {
        throw new Error("max_turns must be a non-negative number");
      }
      const turnLimit = maxTurns && maxTurns > 0 ? Math.floor(maxTurns) : undefined;
      const thinking = request.thinking ?? profile.thinking ?? parent.inner.agent.state?.thinkingLevel;
      if (thinking && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
        throw new Error(`Invalid subagent thinking level: ${thinking}`);
      }

      const agentDir = getAgentDir();
      const parentModelRuntime = (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime;
      const settingsManager = SettingsManager.create(parent.cwd, agentDir);
      const inheritedParentContext = inheritContext
        ? `The following is the active conversation context from the parent session. Use it only as background for the delegated task:\n${parentContextText(parent)}`
        : undefined;
      const inputFiles = loadSubagentInputFiles(parent.cwd, request.inputFiles ?? []);
      const projectInstructions = projectInstructionsForSubagent(
        profile,
        parent.inner.resourceLoader.getAgentsFiles().agentsFiles,
      );
      const promptPlan = buildSubagentPromptPlan({
        profileSystemPrompt: profile.systemPrompt,
        projectInstructions,
        tools: profile.tools,
        loadSkills: profile.loadSkills,
        loadExtensions: profile.loadExtensions,
        task: appendSubagentInputFiles(request.task, inputFiles),
        inheritedParentContext,
      });
      const { chatOnly, appendSystemPrompt, delegatedTask } = promptPlan;
      if (!chatOnly) initTheme();
      const services = await createAgentSessionServices({
        cwd: parent.cwd,
        agentDir,
        modelRuntime: parentModelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          noExtensions: !profile.loadExtensions,
          noSkills: !profile.loadSkills,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          ...(chatOnly
            ? {
                systemPrompt: " ",
                systemPromptOverride: () => undefined,
              }
            : {}),
          appendSystemPrompt,
        },
        ...((profile.loadExtensions || profile.loadSkills)
          ? { resourceLoaderReloadOptions: projectTrustReloadOptions(parent.cwd, agentDir) }
          : {}),
      });

      const extensionToolNames = profile.loadExtensions
        ? services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
        : [];
      const activeTools = resolveShellTools(
        withSubagentExtensionTools(profile.tools, extensionToolNames),
        settingsManager.getDefaultTools(),
      );

      const sessionManager = SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile });
      const createdAt = new Date().toISOString();
      const metadata: SubagentMetadata = {
        version: 1,
        parentSessionId,
        parentSessionPath: parent.sessionFile,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: request.description.trim() || profile.displayName,
        task: request.task,
        runInBackground,
        createdAt,
        resourceSnapshot: {
          version: 1,
          appendSystemPrompt: [...appendSystemPrompt],
          tools: [...activeTools],
          loadSkills: profile.loadSkills,
          loadExtensions: profile.loadExtensions,
        },
      };
      sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
      sessionManager.appendSessionInfo(metadata.description);

      const requestedModel = parseSubagentModel(parentModelRuntime, request.model ?? profile.model);
      const parentModel = parent.inner.model as ReturnType<ModelRuntime["getModel"]>;
      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: requestedModel ?? parentModel,
        ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
        tools: activeTools,
        excludeTools: [...SUBAGENT_CONTROL_TOOL_NAMES],
      });
      dependencies.registerSession(inner, {
        ...(promptPlan.exactSystemPrompt !== undefined
          ? { exactSystemPrompt: promptPlan.exactSystemPrompt }
          : {}),
        chatOnly,
      });

      const initialRun: SubagentRunInfo = {
        sessionId: inner.sessionId,
        sessionPath: inner.sessionFile ?? sessionManager.getSessionFile() ?? "",
        parentSessionId,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: metadata.description,
        task: request.task,
        runInBackground,
        status: "running",
        createdAt,
      };

      let turnLimitState: SubagentTurnLimitState = {
        turnCount: 0,
        wrapUpRequested: false,
        turnLimitReached: false,
      };
      const previousShouldStopAfterTurn = inner.agent.shouldStopAfterTurn;
      if (turnLimit) {
        inner.agent.shouldStopAfterTurn = async (context, signal) => (
          turnLimitState.turnLimitReached || await previousShouldStopAfterTurn?.(context, signal) === true
        );
      }
      const unsubscribeTurns = turnLimit
        ? inner.subscribe((event) => {
            if (event.type !== "turn_end") return;
            const update = advanceSubagentTurnLimit(turnLimitState, event.message, turnLimit);
            turnLimitState = update.state;
            if (update.requestWrapUp) {
              inner.agent.steer?.({
                role: "user",
                content: [{ type: "text", text: "You have reached your turn limit. Wrap up immediately and provide your final answer now without calling more tools." }],
                timestamp: Date.now(),
              });
            }
          })
        : () => {};
      const stored: StoredSubagentExecution = {
        run: initialRun,
        completion: Promise.resolve(initialRun),
        abortRequested: false,
      };
      getSubagentRuns().set(initialRun.sessionId, stored);
      request.onUpdate?.(initialRun);
      dependencies.invalidateSessionList();

      const handleParentAbort = () => {
        stored.abortRequested = true;
        void inner.abort();
      };
      if (!runInBackground) {
        if (request.signal?.aborted) stored.abortRequested = true;
        else request.signal?.addEventListener("abort", handleParentAbort, { once: true });
      }

      stored.completion = (async () => {
        const messageStartIndex = inner.agent.state?.messages?.length ?? 0;
        let thrownError: string | undefined;
        try {
          if (stored.abortRequested) throw new DOMException("Subagent was stopped", "AbortError");
          await inner.prompt(delegatedTask, {
            source: "rpc",
            ...(chatOnly
              ? {
                  preflightResult: (success: boolean) => {
                    if (success && inner.agent.state) {
                      inner.agent.state.systemPrompt = profile.systemPrompt;
                    }
                  },
                }
              : {}),
          });
        } catch (error) {
          thrownError = error instanceof Error ? error.message : String(error);
        } finally {
          unsubscribeTurns();
          inner.agent.shouldStopAfterTurn = previousShouldStopAfterTurn;
          request.signal?.removeEventListener("abort", handleParentAbort);
        }

        const outcome = deriveSubagentOutcome(
          inner.agent.state?.messages?.slice(messageStartIndex) ?? [],
          {
            abortRequested: stored.abortRequested,
            turnLimitReached: turnLimitState.turnLimitReached,
            ...(thrownError ? { thrownError } : {}),
          },
        );
        const result: SubagentRunInfo = {
          ...initialRun,
          ...outcome,
          completedAt: new Date().toISOString(),
        };

        const persisted: SubagentResultMetadata = {
          version: 1,
          status: result.status as SubagentResultMetadata["status"],
          completedAt: result.completedAt!,
          ...(result.wrappedAtTurnLimit ? { wrappedAtTurnLimit: true } : {}),
          ...(result.result ? { result: result.result } : {}),
          ...(result.error ? { error: result.error } : {}),
        };
        sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, persisted);
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(initialRun.sessionId);
        dependencies.invalidateSessionList();
        return result;
      })();

      return { run: initialRun, completion: stored.completion };
    } finally {
      releaseSlot();
    }
  }

  async function get(sessionId: string): Promise<SubagentRunInfo | null> {
    const stored = getSubagentRuns().get(sessionId);
    if (stored) return stored.run;
    const wrapper = dependencies.getSession(sessionId);
    if (wrapper?.isAlive()) {
      const run = readSubagentRun(
        wrapper.inner.sessionManager.getEntries() as unknown as SessionEntry[],
        sessionId,
        wrapper.sessionFile,
      );
      if (run && wrapper.isRunning()) return { ...run, status: "running" };
      if (run) return run;
    }
    const sessionPath = await dependencies.resolveSessionPath(sessionId);
    if (!sessionPath) return null;
    const manager = SessionManager.open(sessionPath);
    return readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, sessionPath);
  }

  async function steer(sessionId: string, message: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (!message.trim()) throw new Error("Steering message is required");
    await wrapper.inner.steer(message.trim());
  }

  async function abort(sessionId: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    const stored = getSubagentRuns().get(sessionId);
    if (stored) stored.abortRequested = true;
    await wrapper.inner.abort();
  }

  return {
    extensionRuntime: { start, get, steer },
    get,
    steer,
    abort,
  };
}
