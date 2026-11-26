// Lets a same-process extension (pi-agy-acp) start a session's sub-agents on behalf of an agent
// that cannot call `Agent` itself. Not a model tool: nothing here is visible to any model.
import type { SessionEntry } from "./types";
import type { AgentSessionLike } from "./pi-types";
import { sideChatParentId } from "./side-chat";
import {
  subagentFinalText,
  subagentModelChoices,
  subagentToolDetails,
  type SubagentToolDetails,
} from "./subagent-extension";
import type { SubagentController } from "./subagent-runtime";
import { readSubagentMetadata, type SubagentProfile, type SubagentRunInfo } from "./subagents";

export const SUBAGENT_BRIDGE_KEY = Symbol.for("pi-web.subagent-bridge.v1");

interface BridgeHostSession {
  readonly inner: AgentSessionLike & { getActiveToolNames(): string[] };
  readonly cwd: string;
  isAlive(): boolean;
}

export interface SubagentBridgeProfile {
  name: string;
  description: string;
  model?: string;
  thinking?: string;
  inheritContext: boolean;
}

export interface SubagentBridgeStart {
  parentSessionId: string;
  /** The parent transcript's tool call that shows this run (its card links to the child). */
  parentToolCallId: string;
  profile: string;
  task: string;
  description: string;
  model?: string;
  thinking?: string;
}

export interface SubagentBridgeResume {
  parentSessionId: string;
  parentToolCallId: string;
  sessionId: string;
  task: string;
}

export interface SubagentBridgeRun {
  run: SubagentRunInfo;
  details: SubagentToolDetails;
}

export interface SubagentBridgeV1 {
  version: 1;
  /** What the session may delegate to; null when it may not delegate (same rule as its `Agent` tool). */
  available(parentSessionId: string): { profiles: SubagentBridgeProfile[]; models: string[] } | null;
  /** Starts a foreground run that the parent's Stop does not cancel; wait for it with `wait`. */
  start(request: SubagentBridgeStart): Promise<SubagentBridgeRun>;
  resume(request: SubagentBridgeResume): Promise<SubagentBridgeRun>;
  /** Resolves when the run settles (at once if it already has); text is the report `Agent` would return. */
  wait(sessionId: string): Promise<SubagentBridgeRun & { text: string }>;
}

export function createSubagentBridge(
  controller: Pick<SubagentController, "extensionRuntime" | "wait">,
  getSession: (sessionId: string) => BridgeHostSession | undefined,
  listProfiles: (cwd: string) => readonly SubagentProfile[],
): SubagentBridgeV1 {
  // The `Agent` tool being active already encodes the host's rules: switched on for the project,
  // an enabled profile, not Chat only or read-only, not itself a sub-agent. Side chats keep the
  // parent's tools but must not act.
  const parentOf = (parentSessionId: string) => {
    const parent = getSession(parentSessionId);
    if (!parent?.isAlive()) return undefined;
    const manager = parent.inner.sessionManager;
    if (!parent.inner.getActiveToolNames().includes("Agent")) return undefined;
    if (sideChatParentId(manager.getHeader())) return undefined;
    if (readSubagentMetadata(manager.getEntries() as unknown as SessionEntry[])) return undefined;
    return parent;
  };
  const required = (parentSessionId: string) => {
    const parent = parentOf(parentSessionId);
    if (!parent) throw new Error("This session cannot start Pi Web sub-agents");
    return parent;
  };
  const result = (run: SubagentRunInfo): SubagentBridgeRun => ({ run, details: subagentToolDetails(run) });
  const settle = (completion: Promise<SubagentRunInfo>) => {
    completion.catch((error) => console.error("[pi-web] bridged subagent failed to settle:", error instanceof Error ? error.message : error));
  };

  return {
    version: 1,
    available(parentSessionId) {
      const parent = parentOf(parentSessionId);
      if (!parent) return null;
      const profiles = listProfiles(parent.cwd).filter((profile) => profile.enabled).map((profile) => ({
        name: profile.name,
        description: profile.description,
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.thinking ? { thinking: profile.thinking } : {}),
        inheritContext: profile.inheritContext,
      }));
      if (profiles.length === 0) return null;
      const runtime = parent.inner.modelRuntime as unknown as { getAvailableSnapshot(): Array<{ provider: string; id: string }> };
      const models = subagentModelChoices(parent.inner.scopedModels ?? [], runtime.getAvailableSnapshot());
      return { profiles, models: models.map((model) => `${model.provider}/${model.id}`) };
    },
    async start(request) {
      const parent = required(request.parentSessionId);
      const execution = await controller.extensionRuntime.start({
        parentContext: { sessionManager: parent.inner.sessionManager },
        parentToolCallId: request.parentToolCallId,
        profile: request.profile,
        task: request.task,
        description: request.description,
        ...(request.model ? { model: request.model } : {}),
        ...(request.thinking ? { thinking: request.thinking } : {}),
        // Foreground keeps the result out of the parent's background wave; no signal, so the
        // parent's Stop leaves it running, as it does a background `Agent` run.
        runInBackground: false,
      });
      settle(execution.completion);
      return result(execution.run);
    },
    async resume(request) {
      const parent = required(request.parentSessionId);
      const execution = await controller.extensionRuntime.resume({
        parentContext: { sessionManager: parent.inner.sessionManager },
        parentToolCallId: request.parentToolCallId,
        sessionId: request.sessionId,
        task: request.task,
        description: "", // keeps the child's title
        runInBackground: false,
      });
      settle(execution.completion);
      return result(execution.run);
    },
    async wait(sessionId) {
      const run = await controller.wait(sessionId);
      if (!run) throw new Error(`Unknown subagent: ${sessionId}`);
      return { ...result(run), text: subagentFinalText(run) };
    },
  };
}

export function installSubagentBridge(bridge: SubagentBridgeV1): void {
  (globalThis as Record<symbol, unknown>)[SUBAGENT_BRIDGE_KEY] = bridge;
}
