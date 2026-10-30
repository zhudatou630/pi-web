/**
 * MCP OAuth sign-in and sign-out from Settings, without a session: what `pi mcp login|logout`
 * do (`dist/extensions/mcp/cli.js`), with the authorization URL streamed to the browser and the
 * redirected URL pasted back when the browser cannot reach the loopback callback. Running sessions
 * reconnect servers that were waiting for a sign-in at their next turn (SDK `reconnectSignedIn`).
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { importSdkFile, loadSafeMcpTransport } from "./builtin-extensions";
import { prepareEntry } from "./mcp-check";
import { isRecord, loadSafeMcpConfig, McpConfigError, type McpConfigValidator, type McpEntry } from "./mcp-config-read";
import type { McpValueParsers } from "./mcp-transport";
import { getProjectTrustStatus } from "./project-trust";

interface Connection {
  state: string; error?: string; tools: unknown[]; challenge?: unknown;
  oauthSettings(): unknown; getClient(): Promise<unknown>; reconnect(): Promise<void>; close(): Promise<void>;
}
interface Store { forServer(name: string, url: string): unknown; remove(name: string, url: string): boolean }
interface Runtime {
  McpServerConnection: new (options: {
    entry: McpEntry; cwd: string; credentials: Store; createTransport: McpTransportFactory; onTools: () => void; log?: unknown;
  }) => Connection;
  McpOAuthCredentialStore: new (backend: unknown, lockDir: string) => Store;
  McpServerLog: new (path: string) => unknown;
  McpSignInCancelledError: new () => Error;
  signInMcpServer(options: {
    serverUrl: string; store: unknown; settings: unknown; challenge?: unknown; signal?: AbortSignal;
    prompt: { showAuthorizationUrl(url: URL): void; promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined> };
  }): Promise<void>;
}

export type McpSignInEvent =
  | { type: "auth"; url: string; token: string }
  | { type: "finishing" }
  | { type: "success"; tools: number; already?: boolean }
  | { type: "cancelled" }
  | { type: "error"; message: string };

interface Paste { state: string | null; redirectUri: string | null; resolve(url: string): void }
declare global {
  // Process-wide: one flow per credential identity, and the pastes the flows wait for.
  var __piMcpSignIns: { flows: Set<string>; pastes: Map<string, Paste> } | undefined;
}
const registry = () => (globalThis.__piMcpSignIns ??= { flows: new Set(), pastes: new Map() });

/** The SDK's rule (`usesOAuth`, extensions/mcp/runtime.js): HTTP without auth.provider or an Authorization header. */
function oauthUrl(entry: McpEntry): string | undefined {
  const config = entry.config as unknown as Record<string, unknown>;
  if (typeof config.url !== "string" || config.auth) return undefined;
  const headers = isRecord(config.headers) ? Object.keys(config.headers) : [];
  return headers.some((header) => header.toLowerCase() === "authorization") ? undefined : config.url;
}

async function loadServer(cwd: string | null, name: string, agentDir: string) {
  const directory = cwd ?? homedir();
  const [validator, runtime, auth] = await Promise.all([
    importSdkFile<McpConfigValidator>("core/mcp-servers.js"),
    importSdkFile<Runtime>("extensions/mcp/runtime.js"),
    importSdkFile<{ FileAuthStorageBackend: new (path: string) => unknown }>("core/auth-storage.js"),
  ]);
  const trusted = cwd ? getProjectTrustStatus(cwd, agentDir).trusted : false;
  const entry = loadSafeMcpConfig({ agentDir, cwd: directory, projectTrusted: trusted }, validator).servers.find((server) => server.name === name);
  if (!entry) throw new McpConfigError(`No MCP server named "${name}"`);
  const url = oauthUrl(entry);
  if (!url) throw new McpConfigError(`MCP server "${name}" does not sign in with OAuth`);
  const credentials = new runtime.McpOAuthCredentialStore(new auth.FileAuthStorageBackend(join(agentDir, "mcp-auth.json")), agentDir);
  return { directory, entry, url, runtime, credentials };
}

/** Resolve a waiting sign-in with the URL the browser was redirected to, once it looks like this flow's callback. */
export function pasteMcpRedirect(token: string, redirectUrl: string): "ok" | "unknown" | "invalid" {
  const paste = registry().pastes.get(token);
  if (!paste) return "unknown";
  let url: URL;
  try { url = new URL(redirectUrl.trim()); } catch { return "invalid"; }
  // The SDK ends the whole sign-in on a bad paste: check it is this flow's callback first.
  if (!url.searchParams.has("code") && !url.searchParams.has("error")) return "invalid";
  if (paste.state !== null && url.searchParams.get("state") !== paste.state) return "invalid";
  if (paste.redirectUri !== null) {
    const expected = new URL(paste.redirectUri);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) return "invalid";
  }
  paste.resolve(url.href);
  return "ok";
}

/** `pi mcp login <name>`: connect first; sign in only when the server asks for it. */
export async function runMcpSignIn(
  input: { cwd: string | null; name: string; signal: AbortSignal; emit: (event: McpSignInEvent) => void },
  agentDir = getAgentDir(),
): Promise<void> {
  const { cwd, name, signal, emit } = input;
  const { directory, entry, url, runtime, credentials } = await loadServer(cwd, name, agentDir);
  const { flows, pastes } = registry();
  const identity = `${entry.name}\0${url}`;
  // The SDK keeps one PKCE verifier per server: a second flow would break the first.
  if (flows.has(identity)) throw new McpConfigError(`A sign-in to "${name}" is already running`);
  flows.add(identity);
  const tokens: string[] = [];
  let connection: Connection | undefined;
  let stopConnection: (() => void) | undefined;
  try {
    const [parsers, createTransport] = await Promise.all([
      importSdkFile<McpValueParsers>("core/resolve-config-value.js"), loadSafeMcpTransport(),
    ]);
    const prepared = await prepareEntry(entry, parsers, directory, agentDir, signal);
    signal.throwIfAborted();
    connection = new runtime.McpServerConnection({
      entry: prepared, cwd: directory, credentials, createTransport,
      log: new runtime.McpServerLog(join(agentDir, "mcp.log")), onTools: () => {},
    });
    // Closing cancels a connect or reconnect in progress; signInMcpServer takes the signal itself.
    const opened = connection;
    signal.addEventListener("abort", stopConnection = () => void opened.close().catch(() => undefined), { once: true });
    try {
      await connection.getClient();
      emit({ type: "success", tools: connection.tools.length, already: true });
      return;
    } catch {
      if (connection.state !== "needs-auth") throw new Error(connection.error ?? `MCP server "${name}" failed to connect`);
    }
    const token = randomUUID();
    tokens.push(token);
    let state: string | null = null;
    let redirectUri: string | null = null;
    await runtime.signInMcpServer({
      serverUrl: url,
      store: credentials.forServer(entry.name, url),
      settings: connection.oauthSettings(),
      challenge: connection.challenge,
      signal,
      prompt: {
        showAuthorizationUrl: (authorizationUrl) => {
          state = authorizationUrl.searchParams.get("state");
          redirectUri = authorizationUrl.searchParams.get("redirect_uri");
          emit({ type: "auth", url: authorizationUrl.href, token });
        },
        // Aborted once the loopback callback arrives (local browser) or the sign-in ends.
        promptForRedirectUrl: (promptSignal) => new Promise((resolve) => {
          const done = (value: string | undefined) => { pastes.delete(token); resolve(value); };
          if (promptSignal.aborted) return done(undefined);
          pastes.set(token, { state, redirectUri, resolve: (value: string) => { emit({ type: "finishing" }); done(value); } });
          promptSignal.addEventListener("abort", () => done(undefined), { once: true });
        }),
      },
    });
    connection.challenge = undefined;
    await connection.reconnect();
    emit({ type: "success", tools: connection.tools.length });
  } catch (error) {
    if (error instanceof runtime.McpSignInCancelledError || signal.aborted) emit({ type: "cancelled" });
    else emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (stopConnection) signal.removeEventListener("abort", stopConnection);
    flows.delete(identity);
    for (const token of tokens) pastes.delete(token);
    await connection?.close().catch(() => undefined);
  }
}

/** `pi mcp logout <name>`: deletes the stored credentials. Returns whether any were stored. */
export async function signOutMcpServer(input: { cwd: string | null; name: string }, agentDir = getAgentDir()): Promise<boolean> {
  const { entry, url, credentials } = await loadServer(input.cwd, input.name, agentDir);
  return credentials.remove(entry.name, url);
}
