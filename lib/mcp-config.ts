/**
 * MCP server configuration for the Settings > MCP page. Reads and writes the same
 * `mcp.json` files as pi (`~/.pi/agent/mcp.json`, project `.pi/mcp.json`) through pi's
 * own helpers, which the SDK ships but does not export, so they load by file path.
 */
import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { McpCheckResponse, McpServerView, McpSettingsResponse } from "./api-types";
import { BUILTIN_EXTENSION_NAMES, BUILTIN_EXTENSION_PREFIX, importSdkFile } from "./builtin-extensions";
import { assertAutoTrustable, getProjectTrustStatus, trustProject } from "./project-trust";
import { ProjectNotTrustedError, resolveScopedResources } from "./project-resource-overrides";

export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];
export type McpScope = "global" | "project";

/** An invalid server entry, reported by pi's own validation. */
export class McpConfigError extends Error {}

/** A server as pi loads it: project overrides are already merged into the global entry. */
interface LoadedMcpServer {
  name: string;
  config: Record<string, unknown>;
  scope?: "global" | "project" | "extension";
  /** Project `mcp.json` that overrides this global server's `enabled`/`exposure`/`toolExposure` (pi 1.0.1+). */
  override?: string;
}

interface McpModules {
  config: {
    loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): { servers: LoadedMcpServer[]; errors: string[] };
    addMcpServerConfig(path: string, name: string, config: unknown): boolean;
    removeMcpServerConfig(path: string, name: string): boolean;
    updateMcpServerConfig(
      path: string,
      name: string,
      patch: { enabled?: boolean; exposure?: McpExposure },
      options?: { override?: boolean },
    ): void;
  };
  servers: { validateMcpServerConfig(name: string, value: unknown): unknown };
  cli: {
    runMcpCommand(args: string[], options: { cwd: string; agentDir: string; log: (line: string) => void; error: (line: string) => void }): Promise<number>;
  };
}

let modulesPromise: Promise<McpModules> | null = null;

// Available since pi 0.99.0.
function loadModules(): Promise<McpModules> {
  modulesPromise ??= (async () => {
    const load = (file: string) => importSdkFile<unknown>(file);
    const [config, servers, cli] = await Promise.all([
      load("extensions/mcp/config.js"),
      load("core/mcp-servers.js"),
      load("extensions/mcp/cli.js"),
    ]);
    return { config, servers, cli } as McpModules;
  })();
  return modulesPromise;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
function readRawServers(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  } catch {
    return {};
  }
}

function toView(server: LoadedMcpServer, scope: McpScope, raw: Record<string, unknown>): McpServerView {
  const written = raw[server.name];
  const config = isRecord(written) ? written : server.config;
  return {
    name: server.name,
    scope,
    config,
    enabled: server.config.enabled !== false,
    // pi 1.0 folded `codemode-deferred` into `codemode` and still accepts the old name.
    exposure: typeof server.config.exposure === "string" && server.config.exposure !== "codemode-deferred" ? server.config.exposure : "codemode",
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
  const { config: helpers } = await loadModules();
  const { resources } = await resolveScopedResources(cwd ?? homedir(), agentDir);
  const builtins = BUILTIN_EXTENSION_NAMES.map((name) => {
    const resource = resources.find((r) => r.type === "extensions" && r.path === `${BUILTIN_EXTENSION_PREFIX}${name}`);
    return { name, enabled: resource?.enabled ?? true, globalEnabled: resource?.globalEnabled ?? true };
  });
  const globalPath = mcpConfigPath("global", null, agentDir);
  // pi's own loader decides validity, precedence, and project overrides; invalid entries become errors.
  const globalOnly = helpers.loadMcpConfig({ agentDir, cwd: cwd ?? homedir(), projectTrusted: false });
  let loaded = globalOnly;
  let project: McpSettingsResponse["project"] = null;
  let rawProject: Record<string, unknown> = {};
  if (cwd) {
    const path = mcpConfigPath("project", cwd, agentDir);
    const trust = getProjectTrustStatus(cwd, agentDir);
    project = { path, trusted: trust.trusted, ignored: !trust.trusted && existsSync(path) };
    // Like pi, an untrusted project's mcp.json is not read at all.
    if (trust.trusted) {
      loaded = helpers.loadMcpConfig({ agentDir, cwd, projectTrusted: true });
      rawProject = readRawServers(path);
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
  if (!status.requiresTrust) await assertAutoTrustable(cwd, (message) => new McpConfigError(message));
}


export async function saveMcpServer(
  input: { cwd: string | null; scope: McpScope; name: string; config: unknown; previousName?: string },
  agentDir = getAgentDir(),
): Promise<void> {
  const { cwd, scope, name, config, previousName } = input;
  await assertWritable(scope, cwd, agentDir);
  const { config: helpers, servers } = await loadModules();
  const validated = servers.validateMcpServerConfig(name, config);
  if (typeof validated === "string") throw new McpConfigError(validated);
  const path = mcpConfigPath(scope, cwd, agentDir);
  // Keep the entry as written (validation only checks it): `${NAME}` references stay unresolved.
  helpers.addMcpServerConfig(path, name, config);
  if (previousName && previousName !== name) helpers.removeMcpServerConfig(path, previousName);
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
    if (!isRecord(readRawServers(mcpConfigPath("global", null, agentDir))[input.name])) {
      throw new McpConfigError(`No global MCP server named "${input.name}" to override`);
    }
  }
  await assertWritable(input.scope, input.cwd, agentDir);
  const { config } = await loadModules();
  config.updateMcpServerConfig(mcpConfigPath(input.scope, input.cwd, agentDir), input.name, {
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.exposure !== undefined ? { exposure: input.exposure } : {}),
  }, input.override ? { override: true } : {});
  // An override may have just created the project mcp.json: record trust like saveMcpServer.
  if (input.override && input.cwd) trustProject(input.cwd, agentDir);
}

export async function removeMcpServer(
  input: { cwd: string | null; scope: McpScope; name: string },
  agentDir = getAgentDir(),
): Promise<void> {
  await assertWritable(input.scope, input.cwd, agentDir);
  const { config } = await loadModules();
  if (!config.removeMcpServerConfig(mcpConfigPath(input.scope, input.cwd, agentDir), input.name)) {
    throw new Error(`No MCP server named "${input.name}"`);
  }
}

/** `pi mcp list --json`: connects to every enabled server once, then disconnects. */
export async function checkMcpServers(cwd: string | null, agentDir = getAgentDir()): Promise<McpCheckResponse> {
  const { cli } = await loadModules();
  const lines: string[] = [];
  const failures: string[] = [];
  await cli.runMcpCommand(["list", "--json"], {
    cwd: cwd ?? homedir(),
    agentDir,
    log: (line) => lines.push(line),
    error: (line) => failures.push(line),
  });
  if (lines.length === 0) throw new Error(failures.join("\n") || "pi mcp list printed nothing");
  return JSON.parse(lines.join("\n")) as McpCheckResponse;
}
