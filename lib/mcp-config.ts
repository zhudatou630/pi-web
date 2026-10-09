/**
 * MCP server configuration for the Settings > MCP page. Reads and writes the same
 * `mcp.json` files as pi, with the SDK's validation/precedence and safe file I/O.
 */
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
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

export function mcpConfigPath(scope: McpScope, cwd: string | null, agentDir = getAgentDir()): string {
  if (scope === "global") return join(agentDir, "mcp.json");
  if (!cwd) throw new Error("cwd required for project MCP servers");
  return join(cwd, CONFIG_DIR_NAME, "mcp.json");
}

function describeTransport(config: Record<string, unknown>): string {
  if (typeof config.url === "string") return config.url;
  const args = Array.isArray(config.args) ? config.args.filter((arg) => typeof arg === "string") : [];
  return [String(config.command ?? ""), ...args].join(" ").trim();
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

function toView(server: McpEntry, scope: McpScope, raw: Record<string, unknown>): McpServerView {
  const written = Object.hasOwn(raw, server.name) ? raw[server.name] : undefined;
  const config = isRecord(written) ? written : { ...server.config };
  return {
    name: server.name,
    scope,
    config,
    enabled: server.config.enabled !== false,
    // pi 1.0 folded `codemode-deferred` into `codemode` and still accepts the old name.
    exposure: server.config.exposure ?? "codemode",
    transport: describeTransport(config),
  };
}

/** The last lines of `mcp.log`, where servers' logging notifications go. */
function readLogTail(path: string, maxBytes = 8192): string {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
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
  return (size > length ? text.slice(text.indexOf("\n") + 1) : text).trimEnd();
}

export async function readMcpSettings(cwd: string | null, agentDir = getAgentDir()): Promise<McpSettingsResponse> {
  const validator = await loadModules();
  const { resources } = await resolveScopedResources(cwd ?? homedir(), agentDir);
  const builtins = BUILTIN_EXTENSION_NAMES.map((name) => {
    const resource = resources.find((r) => r.type === "extensions" && r.path === `${BUILTIN_EXTENSION_PREFIX}${name}`);
    return { name, enabled: resource?.enabled ?? true, globalEnabled: resource?.globalEnabled ?? true };
  });
  const globalPath = mcpConfigPath("global", null, agentDir);
  const globalOnly = loadSafeMcpConfig({ agentDir, cwd: cwd ?? homedir(), projectTrusted: false }, validator);
  let loaded = globalOnly;
  let project: McpSettingsResponse["project"] = null;
  let rawProject: Record<string, unknown> = {};
  if (cwd) {
    const path = mcpConfigPath("project", cwd, agentDir);
    const trust = getProjectTrustStatus(cwd, agentDir);
    project = { path, trusted: trust.trusted, ignored: !trust.trusted && existsSync(path) };
    // Like pi, an untrusted project's mcp.json is not read at all.
    if (trust.trusted) {
      loaded = loadSafeMcpConfig({ agentDir, cwd, projectTrusted: true }, validator);
      rawProject = readRawServers(path, cwd);
    }
  }
  const rawGlobal = readRawServers(globalPath);
  const effective = new Map(loaded.servers.map((server) => [server.name, server]));
  const servers: McpServerView[] = [
    ...globalOnly.servers.map((base) => {
      const current = effective.get(base.name);
      // A full project entry with the same name replaces the global one.
      if (current?.scope === "project") return { ...toView(base, "global", rawGlobal), overridden: true };
      // A project entry without command/url only changes enabled/exposure of the global server.
      if (current?.override) return { ...toView(current, "global", rawGlobal), projectOverride: true };
      return toView(base, "global", rawGlobal);
    }),
    ...loaded.servers.filter((server) => server.scope === "project").map((server) => toView(server, "project", rawProject)),
  ];
  return {
    builtins,
    globalPath,
    project,
    servers,
    errors: loaded.errors,
    logTail: readLogTail(join(agentDir, "mcp.log")),
  };
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
  input: { cwd: string | null; scope: McpScope; name: string; enabled?: boolean; exposure?: McpExposure; override?: boolean },
  agentDir = getAgentDir(),
): Promise<void> {
  if (input.override) {
    if (input.scope !== "project") throw new McpConfigError("override requires the project scope");
    const global = readRawServers(mcpConfigPath("global", null, agentDir));
    if (!Object.hasOwn(global, input.name) || !isRecord(global[input.name])) {
      throw new McpConfigError(`No global MCP server named "${input.name}" to override`);
    }
  }
  await assertWritable(input.scope, input.cwd, agentDir);
  await editMcpConfigFile(mcpConfigPath(input.scope, input.cwd, agentDir),
    (servers) => patchMcpServer(servers, input.name, input, input.override),
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

/** `pi mcp list --json`: connects to every enabled server once, then disconnects. */
export async function checkMcpServers(cwd: string | null, agentDir = getAgentDir()): Promise<McpCheckResponse> {
  const directory = cwd ?? homedir();
  let trusted = false;
  const loaded = loadModules().then((validator) => {
    trusted = cwd ? getProjectTrustStatus(cwd, agentDir).trusted : false;
    return loadSafeMcpConfig({ agentDir, cwd: directory, projectTrusted: trusted }, validator);
  });
  const result = await checkSafeMcpServers(loaded, directory, agentDir);
  if (cwd && !trusted && existsSync(mcpConfigPath("project", cwd, agentDir))) {
    result.note = "Project mcp.json is ignored because the project is not trusted";
  }
  return result;
}
