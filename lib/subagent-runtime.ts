import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { THINKING_LEVELS as VALID_THINKING_LEVELS } from "./thinking-levels";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AgentSessionLike } from "./pi-types";
import {
  subagentFinalText,
  type ResumeSubagentRequest,
  type StartSubagentRequest,
  type SubagentExecution,
  type SubagentExtensionRuntime,
} from "./subagent-extension";
import {
  readSubagentMetadata,
  readSubagentRun,
  resolveSubagentProfile,
  selectSubagentExtensionTools,
  SUBAGENT_CONTROL_TOOL_NAMES,
  SUBAGENT_META_TYPE,
  SUBAGENT_RESULT_TYPE,
  SUBAGENT_STATUS_TYPE,
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
import { isBuiltInSubagentsEnabled, readSubagentSettings } from "./subagent-settings";
import { contextFilesSystemPrompt, createExactSystemPromptExtension, type ContextFileContent } from "./chat-only";
import { SubagentQueue } from "./subagent-queue";
import {
  cleanupIsolatedWorktree,
  createIsolatedWorktree,
  type IsolatedWorktree,
  type IsolatedWorktreeCleanup,
} from "./subagent-worktree";

interface HostSession {
  readonly inner: AgentSessionLike;
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isClosing(): boolean;
  isRunning(): boolean;
  canStartBackgroundFollowUp?(): boolean;
  waitUntilReady(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface SubagentRuntimeDependencies {
  getSession(sessionId: string): HostSession | undefined;
  registerSession(
    inner: AgentSessionLike,
    options?: { chatOnly?: boolean },
  ): void;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  reopenSession?(sessionId: string, sessionPath: string, cwdOverride?: string): Promise<HostSession>;
  isSessionFileMutationReserved?(sessionId: string): boolean;
  invalidateSessionList(): void;
  isBuiltInSubagentsEnabled?(): boolean;
}

export interface SubagentController {
  readonly extensionRuntime: SubagentExtensionRuntime;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  sendUiMessage(sessionId: string, message: string): Promise<{
    action: "steered" | "resumed";
    run: SubagentRunInfo;
  }>;
  flushParentNotifications(parentSessionId: string): boolean;
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
  cancelQueued?: () => boolean;
  waveKey?: string;
};

type BackgroundWave = {
  parentSessionId: string;
  members: string[];
  results: Map<string, SubagentRunInfo>;
  pending: number;
  notifyTimer?: ReturnType<typeof setTimeout>;
};

declare global {
  var __piSubagentRuns: Map<string, StoredSubagentExecution> | undefined;
  var __piSubagentQueue: SubagentQueue<SubagentRunInfo> | undefined;
  var __piSubagentWaves: Map<string, BackgroundWave> | undefined;
  var __piSubagentNotificationParents: Set<string> | undefined;
  var __piSubagentResumeClaims: Set<string> | undefined;
}
const SUBAGENT_CONTEXT_LIMIT = 50_000;
const THINKING_LEVELS = new Set<ThinkingLevel>(VALID_THINKING_LEVELS);

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

function getSubagentQueue(): SubagentQueue<SubagentRunInfo> {
  if (!globalThis.__piSubagentQueue) globalThis.__piSubagentQueue = new SubagentQueue();
  return globalThis.__piSubagentQueue;
}

function getSubagentWaves(): Map<string, BackgroundWave> {
  if (!globalThis.__piSubagentWaves) globalThis.__piSubagentWaves = new Map();
  return globalThis.__piSubagentWaves;
}

function getSubagentNotificationParents(): Set<string> {
  if (!globalThis.__piSubagentNotificationParents) globalThis.__piSubagentNotificationParents = new Set();
  return globalThis.__piSubagentNotificationParents;
}

function getSubagentResumeClaims(): Set<string> {
  if (!globalThis.__piSubagentResumeClaims) globalThis.__piSubagentResumeClaims = new Set();
  return globalThis.__piSubagentResumeClaims;
}

/** Active runs are process state; callers use them to overlay live status on disk data. */
export function getActiveSubagentRuns(): SubagentRunInfo[] {
  return [...getSubagentRuns().values()].map(({ run }) => ({ ...run }));
}

export function isSubagentQueued(sessionId: string): boolean {
  return getSubagentRuns().get(sessionId)?.run.status === "queued";
}

function persistSessionFile(sessionManager: SessionManager): void {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile || existsSync(sessionFile)) return;
  const header = sessionManager.getHeader();
  if (!header) throw new Error("Subagent session is missing its session header");
  const content = [header, ...sessionManager.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
  writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });
  (sessionManager as unknown as { flushed: boolean }).flushed = true;
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

const WAVE_JOIN_HOLD_MS = 100;
const SUBAGENT_NOTIFICATION_MAX_CHARS = 6_000;
const SUBAGENT_NOTIFICATION_RESULT_MAX_CHARS = 1_200;

function subagentResultKey(run: Pick<SubagentRunInfo, "sessionId" | "parentToolCallId">): string {
  return `${run.sessionId}\0${run.parentToolCallId}`;
}

function parentWaveKey(parentSessionId: string, parentContext: StartSubagentRequest["parentContext"]): string {
  // Tool results can advance the branch leaf between sequential tool calls;
  // the assistant message is the stable identity of the parent response.
  const assistantId = [...parentContext.sessionManager.getBranch()]
    .reverse()
    .find((entry) => entry.type === "message" && entry.message.role === "assistant")?.id ?? "root";
  return `${parentSessionId}:${assistantId}`;
}

function attachBackgroundWave(waveKey: string, parentSessionId: string, run: SubagentRunInfo): BackgroundWave {
  const waves = getSubagentWaves();
  const existing = waves.get(waveKey);
  const wave = existing ?? {
    parentSessionId,
    members: [] as string[],
    results: new Map<string, SubagentRunInfo>(),
    pending: 0,
  };
  wave.members.push(subagentResultKey(run));
  wave.pending += 1;
  waves.set(waveKey, wave);
  return wave;
}

function persistTerminal(
  sessionManager: { appendCustomEntry: (type: string, data: unknown) => void },
  result: SubagentRunInfo,
): void {
  const persisted: SubagentResultMetadata = {
    version: 1,
    status: result.status as SubagentResultMetadata["status"],
    completedAt: result.completedAt ?? new Date().toISOString(),
    ...(result.wrappedAtTurnLimit ? { wrappedAtTurnLimit: true } : {}),
    ...(result.result ? { result: result.result } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.worktreeCleanupError ? { worktreeCleanupError: result.worktreeCleanupError } : {}),
    ...(result.worktreeBranch ? { worktreeBranch: result.worktreeBranch } : {}),
  };
  sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, persisted);
}

export function commitSubagentTerminal(
  sessionManager: { appendCustomEntry: (type: string, data: unknown) => void },
  result: SubagentRunInfo,
): { run: SubagentRunInfo; persisted: boolean } {
  try {
    persistTerminal(sessionManager, result);
    return { run: result, persisted: true };
  } catch (error) {
    return {
      run: failedRun(result, new Error(`Failed to persist subagent result: ${errorMessage(error)}`)),
      persisted: false,
    };
  }
}

function removeEmptySubagentWave(waveKey: string, wave: BackgroundWave): void {
  if (wave.pending > 0 || wave.results.size > 0) return;
  if (wave.notifyTimer) {
    clearTimeout(wave.notifyTimer);
    wave.notifyTimer = undefined;
  }
  getSubagentWaves().delete(waveKey);
}

function pendingParentNotificationRuns(parentSessionId: string): SubagentRunInfo[] {
  const pending: SubagentRunInfo[] = [];
  for (const wave of getSubagentWaves().values()) {
    if (wave.parentSessionId !== parentSessionId) continue;
    for (const key of wave.members) {
      const run = wave.results.get(key);
      if (run) pending.push(run);
    }
  }
  return pending;
}

function consumePendingSubagentResult(parentSessionId: string, run: SubagentRunInfo): boolean {
  if (run.parentSessionId !== parentSessionId) return false;
  const resultKey = subagentResultKey(run);
  let consumed = false;
  for (const [waveKey, wave] of getSubagentWaves()) {
    if (wave.parentSessionId !== parentSessionId) continue;
    consumed = wave.results.delete(resultKey) || consumed;
    removeEmptySubagentWave(waveKey, wave);
  }
  return consumed;
}

function subagentNotificationResult(run: SubagentRunInfo): string {
  if (run.status !== "failed") return subagentFinalText(run);
  const failure = `Failure: ${run.error ?? "Unknown error"}`;
  const partial = run.result?.trim();
  return partial ? `${failure}\n\nPartial output:\n${partial}` : failure;
}

function discardPendingParentNotifications(parentSessionId: string): void {
  for (const [waveKey, wave] of getSubagentWaves()) {
    if (wave.parentSessionId !== parentSessionId) continue;
    if (wave.notifyTimer) {
      clearTimeout(wave.notifyTimer);
      wave.notifyTimer = undefined;
    }
    getSubagentWaves().delete(waveKey);
  }
}

function buildSubagentNotification(runs: SubagentRunInfo[]): {
  text: string;
  included: SubagentRunInfo[];
} {
  const footer = "\n\nUse get_subagent_result with a session ID for the full result.";
  const sections: string[] = [];
  const included: SubagentRunInfo[] = [];
  let remaining = SUBAGENT_NOTIFICATION_MAX_CHARS - footer.length - 80;

  for (const run of runs) {
    const description = run.description.slice(0, 160);
    const profile = run.profile.slice(0, 80);
    const header = `## ${description} (${profile}, ${run.status})\nSession ID: ${run.sessionId}\n`;
    const separatorLength = sections.length > 0 ? 2 : 0;
    const bodyLimit = Math.min(
      SUBAGENT_NOTIFICATION_RESULT_MAX_CHARS,
      remaining - header.length - separatorLength,
    );
    if (bodyLimit < 80) break;
    const result = subagentNotificationResult(run);
    const body = result.length <= bodyLimit
      ? result
      : `${result.slice(0, Math.max(0, bodyLimit - 24))}\n[Preview truncated]`;
    const section = header + body;
    sections.push(section);
    included.push(run);
    remaining -= section.length + separatorLength;
  }

  const omitted = runs.length - included.length;
  const omittedNote = omitted > 0 ? `\n\n${omitted} additional result(s) remain pending.` : "";
  const text = `${sections.join("\n\n")}${omittedNote}${footer}`;
  return {
    text: text.length <= SUBAGENT_NOTIFICATION_MAX_CHARS
      ? text
      : `${text.slice(0, SUBAGENT_NOTIFICATION_MAX_CHARS - footer.length)}${footer}`,
    included,
  };
}

function parentHasSubagentNotification(parent: HostSession, notificationId: string): boolean {
  return parent.inner.sessionManager.getEntries().some((entry) => {
    if (entry.type !== "custom_message" || entry.customType !== "pi-web:subagent-notification") return false;
    const details = entry.details;
    return typeof details === "object"
      && details !== null
      && (details as { notificationId?: unknown }).notificationId === notificationId;
  });
}

function flushParentNotifications(
  dependencies: SubagentRuntimeDependencies,
  parentSessionId: string,
): boolean {
  const inFlightParents = getSubagentNotificationParents();
  if (inFlightParents.has(parentSessionId)) {
    return pendingParentNotificationRuns(parentSessionId).length > 0;
  }

  const parent = dependencies.getSession(parentSessionId);
  if (!parent?.isAlive() || parent.isClosing()) {
    discardPendingParentNotifications(parentSessionId);
    return false;
  }
  if (parent.isRunning() || parent.canStartBackgroundFollowUp?.() === false) return false;
  const runs = pendingParentNotificationRuns(parentSessionId);
  if (runs.length === 0) return false;
  const notification = buildSubagentNotification(runs);
  if (notification.included.length === 0) return false;

  inFlightParents.add(parentSessionId);
  const reservations: Array<{
    waveKey: string;
    wave: BackgroundWave;
    resultKey: string;
    run: SubagentRunInfo;
  }> = [];
  for (const [waveKey, wave] of getSubagentWaves()) {
    if (wave.parentSessionId !== parentSessionId) continue;
    for (const run of notification.included) {
      const resultKey = subagentResultKey(run);
      if (wave.results.delete(resultKey)) reservations.push({ waveKey, wave, resultKey, run });
    }
    removeEmptySubagentWave(waveKey, wave);
  }

  const notificationId = randomUUID();
  const delivery = parent.inner.sendCustomMessage({
    customType: "pi-web:subagent-notification",
    content: notification.text,
    display: true,
    details: {
      kind: "pi-web-subagent-wave",
      notificationId,
      sessionIds: notification.included.map((run) => run.sessionId),
      results: notification.included.map((run) => ({
        sessionId: run.sessionId,
        parentToolCallId: run.parentToolCallId,
      })),
    },
  }, { deliverAs: "followUp", triggerTurn: true });
  let continueFlush = true;
  void delivery.catch((error) => {
    continueFlush = parentHasSubagentNotification(parent, notificationId);
    if (!continueFlush && parent.isAlive() && !parent.isClosing()) {
      const waves = getSubagentWaves();
      for (const reservation of reservations) {
        const wave = waves.get(reservation.waveKey) ?? reservation.wave;
        wave.results.set(reservation.resultKey, reservation.run);
        waves.set(reservation.waveKey, wave);
      }
    }
    console.error("[pi-web] failed to notify parent of subagent results:", error instanceof Error ? error.message : error);
  }).finally(() => {
    inFlightParents.delete(parentSessionId);
    if (continueFlush) queueMicrotask(() => flushParentNotifications(dependencies, parentSessionId));
  });
  return parent.isRunning();
}

function settleBackgroundWave(
  dependencies: SubagentRuntimeDependencies,
  waveKey: string,
  result: SubagentRunInfo,
): void {
  const wave = getSubagentWaves().get(waveKey);
  if (!wave) return;
  wave.results.set(subagentResultKey(result), result);
  wave.pending = Math.max(0, wave.pending - 1);
  if (wave.notifyTimer) return;
  wave.notifyTimer = setTimeout(() => {
    wave.notifyTimer = undefined;
    flushParentNotifications(dependencies, wave.parentSessionId);
  }, WAVE_JOIN_HOLD_MS);
}

function abandonBackgroundWave(waveKey: string): void {
  const wave = getSubagentWaves().get(waveKey);
  if (!wave) return;
  wave.pending = Math.max(0, wave.pending - 1);
  removeEmptySubagentWave(waveKey, wave);
}

interface SubagentRunContext {
  manager: SessionManager;
}

interface EnqueueSubagentOptions {
  parentSessionId: string;
  waveKey: string;
  initialRun: SubagentRunInfo;
  manager: SessionManager;
  signal?: AbortSignal;
  runInBackground: boolean;
  onUpdate?: (run: SubagentRunInfo) => void;
  execute: (stored: StoredSubagentExecution, context: SubagentRunContext) => Promise<SubagentRunInfo>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedRun(run: SubagentRunInfo, error: unknown): SubagentRunInfo {
  return {
    ...run,
    status: "failed",
    completedAt: new Date().toISOString(),
    error: errorMessage(error),
  };
}

function applyWorktreeCleanup(
  manager: SessionManager,
  metadata: SubagentMetadata,
  run: SubagentRunInfo,
  cleanup: IsolatedWorktreeCleanup,
): SubagentRunInfo {
  const nextMetadata = { ...metadata };
  delete nextMetadata.worktreeBranch;
  if (!cleanup.cleanupError) delete nextMetadata.worktreePath;
  if (cleanup.branch) nextMetadata.worktreeBranch = cleanup.branch;
  manager.appendCustomEntry(SUBAGENT_META_TYPE, nextMetadata);

  const nextRun = { ...run };
  delete nextRun.worktreeBranch;
  if (cleanup.cleanupError) {
    return {
      ...nextRun,
      ...(cleanup.branch ? { worktreeBranch: cleanup.branch } : {}),
      worktreeCleanupError: cleanup.cleanupError,
    };
  }
  delete nextRun.worktreePath;
  return { ...nextRun, ...(cleanup.branch ? { worktreeBranch: cleanup.branch } : {}) };
}

function enqueueSubagentRun(
  dependencies: SubagentRuntimeDependencies,
  options: EnqueueSubagentOptions,
): SubagentExecution {
  let resolveCompletion!: (run: SubagentRunInfo) => void;
  const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
  const stored: StoredSubagentExecution = {
    run: options.initialRun,
    completion,
    abortRequested: false,
  };
  const context: SubagentRunContext = { manager: options.manager };
  const runs = getSubagentRuns();
  runs.set(options.initialRun.sessionId, stored);
  if (options.runInBackground) {
    stored.waveKey = options.waveKey;
    attachBackgroundWave(options.waveKey, options.parentSessionId, options.initialRun);
  }

  let terminalSettled = false;
  let removeAbortListener = () => {};
  const settle = (result: SubagentRunInfo): SubagentRunInfo => {
    if (terminalSettled) return stored.run;
    terminalSettled = true;
    removeAbortListener();
    const terminal = commitSubagentTerminal(context.manager, result);
    stored.run = terminal.run;
    try { options.onUpdate?.(stored.run); } catch { /* observers must not rewrite the terminal result */ }
    if (runs.get(stored.run.sessionId) === stored) runs.delete(stored.run.sessionId);
    try { dependencies.invalidateSessionList(); } catch { /* cache invalidation is best effort */ }
    if (options.runInBackground && stored.waveKey) {
      if (terminal.persisted) settleBackgroundWave(dependencies, stored.waveKey, stored.run);
      else abandonBackgroundWave(stored.waveKey);
    }
    return stored.run;
  };

  const handleAbort = () => {
    stored.abortRequested = true;
    if (stored.run.status === "queued") {
      stored.cancelQueued?.();
      return;
    }
    const wrapper = dependencies.getSession(options.initialRun.sessionId);
    if (wrapper?.isAlive() && wrapper.isRunning()) void wrapper.inner.abort();
  };
  if (!options.runInBackground) {
    if (options.signal?.aborted) stored.abortRequested = true;
    else if (options.signal) {
      options.signal.addEventListener("abort", handleAbort, { once: true });
      removeAbortListener = () => options.signal?.removeEventListener("abort", handleAbort);
    }
  }

  const execute = async (): Promise<SubagentRunInfo> => {
    if (stored.abortRequested) {
      return settle({ ...stored.run, status: "aborted", completedAt: new Date().toISOString() });
    }
    try {
      return settle(await options.execute(stored, context));
    } catch (error) {
      return settle(failedRun(stored.run, error));
    }
  };

  const finishQueuedAbort = async () => {
    if (stored.run.status !== "queued") return;
    const result = settle({ ...stored.run, status: "aborted", completedAt: new Date().toISOString() });
    resolveCompletion(result);
  };

  let queued: ReturnType<SubagentQueue<SubagentRunInfo>["enqueue"]>;
  try {
    queued = getSubagentQueue().enqueue(
      options.parentSessionId,
      readSubagentSettings().maxConcurrent,
      execute,
      (state) => {
        stored.run = { ...stored.run, status: state };
        options.onUpdate?.(stored.run);
        dependencies.invalidateSessionList();
      },
      finishQueuedAbort,
    );
  } catch (error) {
    const result = settle(failedRun(stored.run, error));
    resolveCompletion(result);
    return { run: result, completion };
  }

  stored.cancelQueued = queued.cancel;
  void queued.promise.then((run) => {
    if (run) resolveCompletion(run);
  }, (error) => {
    const result = settle(failedRun(stored.run, error));
    resolveCompletion(result);
  });
  return { run: stored.run, completion };
}

async function promptSubagent(
  inner: AgentSessionLike,
  task: string,
  stored: StoredSubagentExecution,
  options: { turnLimit?: number; chatOnlySystemPrompt?: string },
): Promise<SubagentOutcome> {
  let turnLimitState: SubagentTurnLimitState = {
    turnCount: 0,
    wrapUpRequested: false,
    turnLimitReached: false,
  };
  const previousShouldStopAfterTurn = inner.agent.shouldStopAfterTurn;
  if (options.turnLimit) {
    inner.agent.shouldStopAfterTurn = async (context, signal) => (
      turnLimitState.turnLimitReached || await previousShouldStopAfterTurn?.(context, signal) === true
    );
  }
  const unsubscribeTurns = options.turnLimit
    ? inner.subscribe((event) => {
        if (event.type !== "turn_end") return;
        const update = advanceSubagentTurnLimit(turnLimitState, event.message, options.turnLimit!);
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

  const messageStartIndex = inner.agent.state?.messages?.length ?? 0;
  let thrownError: string | undefined;
  try {
    if (stored.abortRequested) throw new DOMException("Subagent was stopped", "AbortError");
    await inner.prompt(task, {
      source: "rpc",
      ...(options.chatOnlySystemPrompt !== undefined
        ? {
            preflightResult: (success: boolean) => {
              if (success && inner.agent.state) inner.agent.state.systemPrompt = options.chatOnlySystemPrompt;
            },
          }
        : {}),
    });
  } catch (error) {
    thrownError = errorMessage(error);
  } finally {
    unsubscribeTurns();
    inner.agent.shouldStopAfterTurn = previousShouldStopAfterTurn;
  }

  return deriveSubagentOutcome(
    inner.agent.state?.messages?.slice(messageStartIndex) ?? [],
    {
      abortRequested: stored.abortRequested,
      turnLimitReached: turnLimitState.turnLimitReached,
      ...(thrownError ? { thrownError } : {}),
    },
  );
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

    const profile = resolveSubagentProfile(parent.cwd, request.profile);
    if (!profile) throw new Error(`Unknown or disabled subagent profile: ${request.profile}`);

    const runInBackground = request.runInBackground ?? profile.runInBackground;
    const isolation = profile.isolation === "off" ? undefined : request.isolation ?? profile.isolation;
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
      promptMode: profile.promptMode,
      task: appendSubagentInputFiles(request.task, inputFiles),
      inheritedParentContext,
    });
    const { chatOnly, appendSystemPrompt, delegatedTask } = promptPlan;

    const sessionId = randomUUID();
    const sessionManager = SessionManager.create(
      parent.cwd,
      parent.inner.sessionManager.getSessionDir(),
      { parentSession: parent.sessionFile, id: sessionId },
    );
    const sessionPath = sessionManager.getSessionFile() ?? "";
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
      ...(turnLimit ? { maxTurns: turnLimit } : {}),
      ...(isolation ? { isolation } : {}),
      createdAt,
      resourceSnapshot: {
        version: 1,
        appendSystemPrompt: [...appendSystemPrompt],
        tools: [...profile.tools],
        loadSkills: profile.loadSkills,
        loadExtensions: profile.loadExtensions,
        ...(promptPlan.exactSystemPrompt !== undefined
          ? { exactSystemPrompt: promptPlan.exactSystemPrompt }
          : {}),
      },
    };
    sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
    sessionManager.appendSessionInfo(metadata.description);
    sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
    persistSessionFile(sessionManager);

    const initialRun: SubagentRunInfo = {
      sessionId,
      sessionPath,
      parentSessionId,
      parentToolCallId: request.parentToolCallId,
      profile: profile.name,
      description: metadata.description,
      task: request.task,
      runInBackground,
      ...(turnLimit ? { maxTurns: turnLimit } : {}),
      ...(isolation ? { isolation } : {}),
      status: "queued",
      createdAt,
    };
    const execution = enqueueSubagentRun(dependencies, {
      parentSessionId,
      waveKey: parentWaveKey(parentSessionId, request.parentContext),
      initialRun,
      manager: sessionManager,
      signal: request.signal,
      runInBackground,
      onUpdate: request.onUpdate,
      execute: async (stored, context) => {
        let isolated: IsolatedWorktree | undefined;
        let currentMetadata = metadata;
        let childWrapper: HostSession | undefined;
        try {
          if (isolation === "worktree") isolated = await createIsolatedWorktree(parent.cwd, sessionId);
          const childCwd = isolated?.workPath ?? parent.cwd;
          if (isolated) {
            context.manager = SessionManager.open(sessionPath, undefined, childCwd);
            currentMetadata = { ...metadata, worktreePath: isolated.path, worktreeBranch: isolated.branch };
            context.manager.appendCustomEntry(SUBAGENT_META_TYPE, currentMetadata);
            stored.run = { ...stored.run, worktreePath: isolated.path, worktreeBranch: isolated.branch };
            request.onUpdate?.(stored.run);
          }
          const settingsManager = SettingsManager.create(childCwd, agentDir);
          if (!chatOnly) initTheme();
          const services = await createAgentSessionServices({
            cwd: childCwd,
            agentDir,
            modelRuntime: parentModelRuntime,
            settingsManager,
            resourceLoaderOptions: {
              noExtensions: !profile.loadExtensions,
              noSkills: !profile.loadSkills,
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
              ...(promptPlan.exactSystemPrompt !== undefined
                ? {
                    extensionFactories: [createExactSystemPromptExtension(promptPlan.exactSystemPrompt)],
                    systemPrompt: " ",
                    systemPromptOverride: () => undefined,
                    appendSystemPrompt: [],
                  }
                : { systemPrompt: " ", systemPromptOverride: () => undefined, appendSystemPrompt }),
            },
            ...((profile.loadExtensions || profile.loadSkills)
              ? { resourceLoaderReloadOptions: projectTrustReloadOptions(childCwd, agentDir) }
              : {}),
          });
          const extensionToolNames = profile.loadExtensions
            ? profile.extensionTools?.length
              ? selectSubagentExtensionTools(services.resourceLoader.getExtensions().extensions, profile.extensionTools)
              : services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
            : [];
          const activeTools = resolveShellTools(
            withSubagentExtensionTools(profile.tools, extensionToolNames),
            settingsManager.getDefaultTools(),
          );
          const runtimeMetadata: SubagentMetadata = {
            ...currentMetadata,
            resourceSnapshot: { ...currentMetadata.resourceSnapshot, tools: [...activeTools] },
          };
          context.manager.appendCustomEntry(SUBAGENT_META_TYPE, runtimeMetadata);
          currentMetadata = runtimeMetadata;
          const requestedModel = parseSubagentModel(parentModelRuntime, request.model ?? profile.model);
          const parentModel = parent.inner.model as ReturnType<ModelRuntime["getModel"]>;
          const { session: inner } = await createAgentSessionFromServices({
            services,
            sessionManager: context.manager,
            model: requestedModel ?? parentModel,
            ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
            tools: activeTools,
            excludeTools: [...SUBAGENT_CONTROL_TOOL_NAMES],
          });
          dependencies.registerSession(inner, { chatOnly });
          childWrapper = dependencies.getSession(sessionId);
          await childWrapper?.waitUntilReady();
          if (stored.abortRequested) {
            const cleanup = isolated ? await cleanupIsolatedWorktree(parent.cwd, isolated, metadata.description) : undefined;
            isolated = undefined;
            return cleanup
              ? applyWorktreeCleanup(context.manager, currentMetadata, {
                  ...stored.run,
                  status: "aborted",
                  completedAt: new Date().toISOString(),
                }, cleanup)
              : {
                  ...stored.run,
                  status: "aborted",
                  completedAt: new Date().toISOString(),
                };
          }
          context.manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
          stored.run = { ...stored.run, status: "running", sessionPath: inner.sessionFile ?? sessionPath };
          request.onUpdate?.(stored.run);
          dependencies.invalidateSessionList();
          const outcome = await promptSubagent(inner, delegatedTask, stored, {
            turnLimit,
            ...(chatOnly ? { chatOnlySystemPrompt: profile.systemPrompt } : {}),
          });
          let result: SubagentRunInfo = { ...stored.run, ...outcome, completedAt: new Date().toISOString() };
          if (isolated) {
            const cleanup = await cleanupIsolatedWorktree(parent.cwd, isolated, metadata.description);
            isolated = undefined;
            result = applyWorktreeCleanup(context.manager, currentMetadata, result, cleanup);
          }
          return result;
        } catch (error) {
          if (childWrapper?.isAlive()) await childWrapper.shutdown();
          if (isolated) {
            const cleanup = await cleanupIsolatedWorktree(parent.cwd, isolated, metadata.description);
            stored.run = applyWorktreeCleanup(context.manager, currentMetadata, stored.run, cleanup);
          }
          throw error;
        }
      },
    });
    return execution;
  }

  async function resume(request: ResumeSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const existing = await get(request.sessionId);
    if (!existing) throw new Error(`Subagent not found: ${request.sessionId}`);
    if (existing.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    if (existing.status === "running" || existing.status === "queued") throw new Error("Subagent is already running");
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    if (dependencies.isSessionFileMutationReserved?.(request.sessionId)) {
      throw new Error("Session file is being modified");
    }
    let sessionPath = existing.sessionPath || await dependencies.resolveSessionPath(request.sessionId);
    if (!sessionPath || !existsSync(sessionPath)) {
      sessionPath = await dependencies.resolveSessionPath(request.sessionId) || "";
    }
    if (!sessionPath || !existsSync(sessionPath)) throw new Error(`Subagent session file not found: ${request.sessionId}`);
    let wrapper = dependencies.getSession(request.sessionId);
    if (wrapper?.isClosing()) wrapper = undefined;
    if (wrapper?.isAlive() && wrapper.isRunning()) throw new Error("Subagent is already running");

    const runInBackground = request.runInBackground ?? existing.runInBackground;
    const maxTurns = existing.maxTurns;
    const isolation = existing.isolation;
    const initialRun: SubagentRunInfo = {
      ...existing,
      parentToolCallId: request.parentToolCallId,
      task: request.task,
      description: request.description.trim() || existing.description,
      runInBackground,
      ...(maxTurns ? { maxTurns } : {}),
      ...(isolation ? { isolation } : {}),
      status: "queued",
      completedAt: undefined,
      wrappedAtTurnLimit: undefined,
      result: undefined,
      error: undefined,
      worktreePath: undefined,
      worktreeBranch: undefined,
      worktreeCleanupError: undefined,
    };
    const claims = getSubagentResumeClaims();
    if (claims.has(request.sessionId) || getSubagentRuns().has(request.sessionId)) {
      throw new Error("Subagent is already running");
    }
    claims.add(request.sessionId);
    try {
      const manager = wrapper?.isAlive() && !wrapper.isClosing()
        ? wrapper.inner.sessionManager
        : SessionManager.open(sessionPath);
      const metadata = readSubagentMetadata(manager.getEntries() as unknown as SessionEntry[]);
      if (!metadata) throw new Error(`Subagent metadata not found: ${request.sessionId}`);
      const resumedMetadata: SubagentMetadata = {
        ...metadata,
        parentToolCallId: request.parentToolCallId,
        task: request.task,
        description: initialRun.description,
        runInBackground,
        ...(maxTurns ? { maxTurns } : {}),
        ...(isolation ? { isolation } : {}),
      };
      delete resumedMetadata.worktreePath;
      delete resumedMetadata.worktreeBranch;
      manager.appendCustomEntry(SUBAGENT_META_TYPE, resumedMetadata);
      manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
      const execution = enqueueSubagentRun(dependencies, {
        parentSessionId,
        waveKey: parentWaveKey(parentSessionId, request.parentContext),
        initialRun,
        manager,
        signal: request.signal,
        runInBackground,
        onUpdate: request.onUpdate,
        execute: async (stored, context) => {
          let isolated: IsolatedWorktree | undefined;
          let currentMetadata = resumedMetadata;
          let reopened = false;
          try {
            if (isolation === "worktree") {
              isolated = await createIsolatedWorktree(parent.cwd, request.sessionId);
              currentMetadata = { ...resumedMetadata, worktreePath: isolated.path, worktreeBranch: isolated.branch };
              context.manager.appendCustomEntry(SUBAGENT_META_TYPE, currentMetadata);
              stored.run = { ...stored.run, worktreePath: isolated.path, worktreeBranch: isolated.branch };
              request.onUpdate?.(stored.run);
              if (wrapper?.isAlive() && !wrapper.isClosing()) {
                await wrapper.shutdown();
              }
              wrapper = undefined;
            }
            if (!wrapper?.isAlive() || wrapper.isClosing()) {
              if (!dependencies.reopenSession) throw new Error("Subagent session is no longer available");
              wrapper = await dependencies.reopenSession(
                request.sessionId,
                sessionPath,
                isolated?.workPath,
              );
              reopened = true;
            }
            if (!wrapper.isAlive()) throw new Error("Subagent session is no longer available");
            await wrapper.waitUntilReady();
            context.manager = wrapper.inner.sessionManager;
            if (isolated) {
              context.manager.appendCustomEntry(SUBAGENT_META_TYPE, currentMetadata);
            }
            if (stored.abortRequested) {
              const cleanup = isolated ? await cleanupIsolatedWorktree(parent.cwd, isolated, resumedMetadata.description) : undefined;
              isolated = undefined;
              return cleanup
                ? applyWorktreeCleanup(context.manager, currentMetadata, {
                    ...stored.run,
                    status: "aborted",
                    completedAt: new Date().toISOString(),
                  }, cleanup)
                : {
                    ...stored.run,
                    status: "aborted",
                    completedAt: new Date().toISOString(),
                  };
            }
            context.manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
            stored.run = { ...stored.run, status: "running" };
            request.onUpdate?.(stored.run);
            dependencies.invalidateSessionList();
            const outcome = await promptSubagent(wrapper.inner, request.task, stored, { turnLimit: maxTurns });
            let result: SubagentRunInfo = { ...stored.run, ...outcome, completedAt: new Date().toISOString() };
            if (isolated) {
              const cleanup = await cleanupIsolatedWorktree(parent.cwd, isolated, resumedMetadata.description);
              isolated = undefined;
              result = applyWorktreeCleanup(context.manager, currentMetadata, result, cleanup);
            }
            return result;
          } catch (error) {
            if (reopened && wrapper?.isAlive()) await wrapper.shutdown();
            if (isolated) {
              const cleanup = await cleanupIsolatedWorktree(parent.cwd, isolated, resumedMetadata.description);
              stored.run = applyWorktreeCleanup(context.manager, currentMetadata, stored.run, cleanup);
            }
            throw error;
          }
        },
      });
      claims.delete(request.sessionId);
      return execution;
    } catch (error) {
      claims.delete(request.sessionId);
      throw error;
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
    if (!sessionPath || !existsSync(sessionPath)) return null;
    const manager = SessionManager.open(sessionPath);
    return readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, sessionPath);
  }

  async function getForParent(parentSessionId: string, sessionId: string): Promise<SubagentRunInfo | null> {
    const run = await get(sessionId);
    if (run && run.parentSessionId !== parentSessionId) {
      throw new Error("Subagent does not belong to this parent session");
    }
    return run;
  }

  async function steer(sessionId: string, message: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (!message.trim()) throw new Error("Steering message is required");
    await wrapper.inner.steer(message.trim());
  }

  async function steerForParent(parentSessionId: string, sessionId: string, message: string): Promise<void> {
    const run = await getForParent(parentSessionId, sessionId);
    if (!run) throw new Error(`Subagent not found: ${sessionId}`);
    await steer(sessionId, message);
  }

  async function abort(sessionId: string): Promise<void> {
    const stored = getSubagentRuns().get(sessionId);
    if (stored) {
      stored.abortRequested = true;
      if (stored.run.status === "queued") {
        if (!stored.cancelQueued?.()) throw new Error("Subagent is no longer queued");
        return;
      }
      const wrapper = dependencies.getSession(sessionId);
      if (wrapper?.isAlive() && wrapper.isRunning()) await wrapper.inner.abort();
      return;
    }
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    await wrapper.inner.abort();
  }

  async function sendUiMessage(sessionId: string, message: string): Promise<{
    action: "steered" | "resumed";
    run: SubagentRunInfo;
  }> {
    const task = message.trim();
    if (!task) throw new Error("Subagent message is required");
    const existing = await get(sessionId);
    if (!existing) throw new Error(`Subagent not found: ${sessionId}`);
    if (existing.status === "queued") throw new Error("Subagent is queued");
    if (existing.status === "starting" || existing.status === "running") {
      await steer(sessionId, task);
      return { action: "steered", run: existing };
    }

    let parent = dependencies.getSession(existing.parentSessionId);
    if (!parent?.isAlive() || parent.isClosing()) {
      const parentPath = await dependencies.resolveSessionPath(existing.parentSessionId);
      if (!parentPath || !dependencies.reopenSession) {
        throw new Error("Parent session is no longer available");
      }
      parent = await dependencies.reopenSession(existing.parentSessionId, parentPath);
    }
    await parent.waitUntilReady();
    const execution = await resume({
      parentContext: { sessionManager: parent.inner.sessionManager },
      parentToolCallId: `ui:${randomUUID()}`,
      sessionId,
      task,
      description: existing.description,
      runInBackground: true,
    });
    return { action: "resumed", run: execution.run };
  }

  return {
    extensionRuntime: {
      start,
      resume,
      get: getForParent,
      steer: steerForParent,
      consume: consumePendingSubagentResult,
    },
    get,
    steer,
    abort,
    sendUiMessage,
    flushParentNotifications: (parentSessionId) => flushParentNotifications(dependencies, parentSessionId),
  };
}
