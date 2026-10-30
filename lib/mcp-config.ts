/**
 * MCP server configuration for the Settings > MCP page. Reads and writes the same
 * `mcp.json` files as pi, with the SDK's validation/precedence and safe file I/O.
 */
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import type { McpValueParsers } from "./mcp-transport";
import { describeMcpServer } from "./mcp-view";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { McpCheckResponse, McpServerView, McpSettingsResponse } from "./api-types";
import { BUILTIN_EXTENSION_NAMES, BUILTIN_EXTENSION_PREFIX, importSdkFile } from "./builtin-extensions";
import { assertAutoTrustable, getProjectTrustStatus, trustProjectAutomatically as trustProject } from "./project-trust";
import { ProjectNotTrustedError, resolveScopedResources } from "./project-resource-overrides";
import { isRecord, McpConfigError, loadSafeMcpConfig, readMcpConfigFile, type McpConfigValidator, type McpEntry } from "./mcp-config-read";
import { editMcpConfigFile, patchMcpServer } from "./mcp-config-file";
import { checkSafeMcpServers } from "./mcp-check";

export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];
export type McpScope = "global" | "project";

export { McpConfigError } from "./mcp-config-read";

let modulesPromise: Promise<McpConfigValidator> | null = null;

function loadModules(): Promise<McpConfigValidator> {
  modulesPromise ??= importSdkFile<McpConfigValidator>("core/mcp-servers.js");
  return modulesPromise;
}

interface CredentialModules {
  McpOAuthCredentialStore: new (backend: unknown, lockDir: string) => { tokens(name: string, url: string): unknown };
  FileAuthStorageBackend: new (path: string) => unknown;
}

const credentialKey = (name: string, url: string) => `${name}\0${url}`;

/** `credentialKey`s of OAuth servers with tokens in `mcp-auth.json`; read only when the file exists. */
async function signedInServers(servers: { name: string; url?: string }[], agentDir: string): Promise<Set<string>> {
  const path = join(agentDir, "mcp-auth.json");
  const oauth = servers.filter((server) => server.url);
  if (oauth.length === 0 || !existsSync(path)) return new Set();
  const [runtime, auth] = await Promise.all([
    importSdkFile<Pick<CredentialModules, "McpOAuthCredentialStore">>("extensions/mcp/runtime.js"),
    importSdkFile<Pick<CredentialModules, "FileAuthStorageBackend">>("core/auth-storage.js"),
  ]);
  const store = new runtime.McpOAuthCredentialStore(new auth.FileAuthStorageBackend(path), agentDir);
  return new Set(oauth.filter((server) => {
    try { return store.tokens(server.name, server.url!) !== undefined; } catch { return false; }
  }).map((server) => credentialKey(server.name, server.url!)));
}

export function mcpConfigPath(scope: McpScope, cwd: string | null, agentDir = getAgentDir()): string {
  if (scope === "global") return join(agentDir, "mcp.json");
  if (!cwd) throw new Error("cwd required for project MCP servers");
  return join(cwd, CONFIG_DIR_NAME, "mcp.json");
}

/** `mcpServers` entries as written (unresolved `${NAME}` references), for editing. Errors come from pi's loader. */
function readRawServers(path: string, projectRoot?: string): Record<string, unknown> {
  try {
    const { document } = readMcpConfigFile(path, projectRoot);
    return isRecord(document.mcpServers) ? document.mcpServers : {};
  } catch {
    return {}; // loadSafeMcpConfig already reports the sanitized file error.
  }
}

/** Secrets never leave through this view; `readMcpServerEntry` serves "Edit JSON". */
function toView(server: McpEntry, scope: McpScope, parsers: McpValueParsers, signedIn: Set<string>): McpServerView {
  // The loader's config: as written (`${NAME}` unresolved), merged with a project override.
  const facts = describeMcpServer(server.config as unknown as Record<string, unknown>, parsers);
  return {
    name: server.name,
    scope,
    enabled: server.config.enabled !== false,
    // pi 1.0 folded `codemode-deferred` into `codemode` and still accepts the old name.
    exposure: server.config.exposure ?? "codemode",
    ...facts,
    ...(facts.usesOAuth && "url" in server.config ? { signedIn: signedIn.has(credentialKey(server.name, server.config.url)) } : {}),
  };
}

/** The last lines of `mcp.log`, where servers' logging notifications go, and when it was last written. */
function readLogTail(path: string, maxBytes = 8192): { logTail: string; logModified: string | null } {
  if (!existsSync(path)) return { logTail: "", logModified: null };
  const { size, mtime } = statSync(path);
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  // Drop a partial first line when the tail starts mid-file.
  return {
    logTail: (size > length ? text.slice(text.indexOf("\n") + 1) : text).trimEnd(),
    // The log outlives removed servers, so its age tells stale lines from current ones.
    logModified: mtime.toISOString(),
  };
}

export async function readMcpSettings(cwd: string | null, agentDir = getAgentDir()): Promise<McpSettingsResponse> {
  const [validator, parsers] = await Promise.all([loadModules(), importSdkFile<McpValueParsers>("core/resolve-config-value.js")]);
  const { resources } = await resolveScopedResources(cwd ?? homedir(), agentDir);
  const builtins = BUILTIN_EXTENSION_NAMES.map((name) => {
    const resource = resources.find((r) => r.type === "extensions" && r.path === `${BUILTIN_EXTENSION_PREFIX}${name}`);
    return { name, enabled: resource?.enabled ?? true, globalEnabled: resource?.globalEnabled ?? true };
  });
  const globalPath = mcpConfigPath("global", null, agentDir);
  const globalOnly = loadSafeMcpConfig({ agentDir, cwd: cwd ?? homedir(), projectTrusted: false }, validator);
  let loaded = globalOnly;
  let project: McpSettingsResponse["project"] = null;
  if (cwd) {
    const path = mcpConfigPath("project", cwd, agentDir);
    const trust = getProjectTrustStatus(cwd, agentDir);
    project = { path, trusted: trust.trusted, ignored: !trust.trusted && existsSync(path) };
    // Like pi, an untrusted project's mcp.json is not read at all.
    if (trust.trusted) loaded = loadSafeMcpConfig({ agentDir, cwd, projectTrusted: true }, validator);
  }
  const effective = new Map(loaded.servers.map((server) => [server.name, server]));
  const signedIn = await signedInServers(
    [...globalOnly.servers, ...loaded.servers].map((server) => ({ name: server.name, url: "url" in server.config ? server.config.url : undefined })),
    agentDir,
  );
  const view = (server: McpEntry, scope: McpScope) => toView(server, scope, parsers, signedIn);
  const servers: McpServerView[] = [
    ...globalOnly.servers.map((base) => {
      const current = effective.get(base.name);
      // A full project entry with the same name replaces the global one.
      if (current?.scope === "project") return { ...view(base, "global"), overridden: true };
      // A project entry without command/url only changes enabled/exposure/toolExposure of the global server.
      if (current?.override) return { ...view(current, "global"), projectOverride: true };
      return view(base, "global");
    }),
    ...loaded.servers.filter((server) => server.scope === "project").map((server) => view(server, "project")),
  ];
  return {
    builtins,
    globalPath,
    project,
    servers,
    errors: loaded.errors,
    ...(loaded.autoEnableCodemode === false ? { autoEnableCodemode: false } : {}),
    ...readLogTail(join(agentDir, "mcp.log")),
  };
}

/** One entry as written, for "Edit JSON": the only response that carries its secrets. */
export async function readMcpServerEntry(
  input: { cwd: string | null; scope: McpScope; name: string },
  agentDir = getAgentDir(),
): Promise<Record<string, unknown>> {
  const { cwd, scope, name } = input;
  if (scope === "project") {
    if (!cwd) throw new McpConfigError("cwd required for project MCP servers");
    if (!getProjectTrustStatus(cwd, agentDir).trusted) throw new ProjectNotTrustedError("Trust this project before reading its MCP servers");
  }
  const path = mcpConfigPath(scope, cwd, agentDir);
  const { document } = readMcpConfigFile(path, scope === "project" ? cwd! : undefined);
  const servers = isRecord(document.mcpServers) ? document.mcpServers : {};
  const entry = Object.hasOwn(servers, name) ? servers[name] : undefined;
  if (!isRecord(entry)) throw new McpConfigError(`No MCP server named "${name}"`);
  return entry;
}

/** Project `mcp.json` runs commands, so it is only written where the project is trusted or needs no trust yet. */
async function assertWritable(scope: McpScope, cwd: string | null, agentDir: string): Promise<void> {
  if (scope !== "project") return;
  if (!cwd) throw new Error("cwd required for project MCP servers");
  const status = getProjectTrustStatus(cwd, agentDir);
  if (status.requiresTrust && !status.trusted) {
    throw new ProjectNotTrustedError("Trust this project before changing its MCP servers");
  }
  // A fresh folder gets trusted by saveMcpServer below; refuse folders where that trust would spread.
  if (!status.requiresTrust) await assertAutoTrustable(cwd, (message) => new McpConfigError(message), agentDir);
}


export async function saveMcpServer(
  input: { cwd: string | null; scope: McpScope; name: string; config: unknown; previousName?: string },
  agentDir = getAgentDir(),
): Promise<void> {
  const { cwd, scope, name, config, previousName } = input;
  await assertWritable(scope, cwd, agentDir);
  const servers = await loadModules();
  const validated = servers.validateMcpServerConfig(name, config);
  if (typeof validated === "string") throw new McpConfigError(validated);
  // pi skips such project entries (`loadMcpConfig`): a repository must not pick where a credential goes.
  if (scope === "project" && "url" in validated && validated.auth) {
    throw new McpConfigError(`server "${name}": auth is only allowed in the global mcp.json`);
  }
  const path = mcpConfigPath(scope, cwd, agentDir);
  // Keep the entry as written (validation only checks it): `${NAME}` references stay unresolved.
  await editMcpConfigFile(path, (entries) => {
    Object.defineProperty(entries, name, { value: config, enumerable: true, configurable: true, writable: true });
    if (previousName && previousName !== name) delete entries[previousName];
  }, scope === "project" ? cwd! : undefined);
  // The user just authored this project file: if it is why the folder now needs trust, record
  // that trust (assertWritable already refused projects that need trust and lack it).
  if (scope === "project" && cwd) trustProject(cwd, agentDir);
}

/**
 * `override` (project scope only) writes a project override of the global server with this name,
 * adding the entry when missing, like pi's "Enable/Disable in this project".
 */
export async function updateMcpServer(
  input: {
    cwd: string | null; scope: McpScope; name: string; enabled?: boolean; exposure?: McpExposure;
    /** Per-tool rules to set; `null` deletes that exact key. */
    toolExposure?: Record<string, McpExposure | null>;
    override?: boolean;
  },
  agentDir = getAgentDir(),
): Promise<void> {
  let inherited: unknown;
  if (input.override) {
    if (input.scope !== "project") throw new McpConfigError("override requires the project scope");
    const global = readRawServers(mcpConfigPath("global", null, agentDir));
    if (!Object.hasOwn(global, input.name) || !isRecord(global[input.name])) {
      throw new McpConfigError(`No global MCP server named "${input.name}" to override`);
    }
    inherited = (global[input.name] as Record<string, unknown>).toolExposure;
  }
  await assertWritable(input.scope, input.cwd, agentDir);
  await editMcpConfigFile(mcpConfigPath(input.scope, input.cwd, agentDir),
    (servers) => patchMcpServer(servers, input.name, input, input.override, inherited),
    input.scope === "project" ? input.cwd! : undefined);
  // An override may have just created the project mcp.json: record trust like saveMcpServer.
  if (input.override && input.cwd) trustProject(input.cwd, agentDir);
}

export async function removeMcpServer(
  input: { cwd: string | null; scope: McpScope; name: string },
  agentDir = getAgentDir(),
): Promise<void> {
  await assertWritable(input.scope, input.cwd, agentDir);
  await editMcpConfigFile(mcpConfigPath(input.scope, input.cwd, agentDir), (servers) => {
    if (!Object.hasOwn(servers, input.name)) throw new McpConfigError(`No MCP server named "${input.name}"`);
    delete servers[input.name];
  }, input.scope === "project" ? input.cwd! : undefined);
}

/**
 * Like `pi mcp list --json`: connects to every enabled server once (or only the effective entry
 * named `only`), then disconnects.
 */
export async function checkMcpServers(
  cwd: string | null, agentDir = getAgentDir(), only?: string,
): Promise<McpCheckResponse> {
  const directory = cwd ?? homedir();
  let trusted = false;
  const loaded = loadModules().then((validator) => {
    trusted = cwd ? getProjectTrustStatus(cwd, agentDir).trusted : false;
    const config = loadSafeMcpConfig({ agentDir, cwd: directory, projectTrusted: trusted }, validator);
    if (!only) return config;
    const servers = config.servers.filter((server) => server.name === only);
    if (servers.length === 0) throw new McpConfigError(`No MCP server named "${only}"`);
    return { ...config, servers };
  });
  // Lazily, per request: only servers with `auth.provider` need the model runtime.
  let registry: Promise<ModelRegistry> | undefined;
  const providerToken = async (provider: string) => {
    // Loaded on use: it pulls in the request-scoped cwd helpers (`@/` imports).
    registry ??= import("./model-config-services")
      .then(({ createModelsConfigServices }) => createModelsConfigServices(directory))
      .then((services) => new ModelRegistry(services.modelRuntime));
    return (await registry).getApiKeyForProvider(provider);
  };
  const result = await checkSafeMcpServers(loaded, directory, agentDir, providerToken);
  if (cwd && !trusted && existsSync(mcpConfigPath("project", cwd, agentDir))) {
    result.note = "Project mcp.json is ignored because the project is not trusted";
  }
  return result;
}
