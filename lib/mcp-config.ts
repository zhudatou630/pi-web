/**
 * MCP server configuration for the Settings > MCP page. Reads and writes the same
 * `mcp.json` files as pi (`~/.pi/agent/mcp.json`, project `.pi/mcp.json`) through pi's
 * own helpers, which the SDK ships but does not export, so they load by file path.
 */
import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import type { McpCheckResponse, McpServerView, McpSettingsResponse } from "./api-types";
import { BUILTIN_EXTENSION_NAMES, BUILTIN_EXTENSION_PREFIX } from "./builtin-extensions";
import { getProjectTrustStatus, trustProject } from "./project-trust";
import { ProjectNotTrustedError, resolveScopedResources } from "./project-resource-overrides";

export const MCP_EXPOSURES = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];
export type McpScope = "global" | "project";

/** An invalid server entry, reported by pi's own validation. */
export class McpConfigError extends Error {}

interface McpModules {
  config: {
    addMcpServerConfig(path: string, name: string, config: unknown): boolean;
    removeMcpServerConfig(path: string, name: string): boolean;
    updateMcpServerConfig(path: string, name: string, patch: { enabled?: boolean; exposure?: McpExposure }): void;
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
    // Loaded at runtime from the installed SDK, not bundled: the bundler cannot follow a computed path.
    const load = (file: string) => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(join(getPackageDir(), "dist", file)).href);
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

type Validate = McpModules["servers"]["validateMcpServerConfig"];

/** Entries pi would load; invalid ones are reported like pi does, not listed as servers. */
function readServers(path: string, scope: McpScope, errors: string[], validate: Validate): McpServerView[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    errors.push(`${path}: expected an object with an "mcpServers" object`);
    return [];
  }
  return Object.entries(parsed.mcpServers ?? {}).flatMap(([name, config]) => {
    const problem = validate(name, config);
    if (typeof problem === "string" || !isRecord(config)) {
      errors.push(`${path}: ${typeof problem === "string" ? problem : `invalid MCP server "${name}"`}`);
      return [];
    }
    return [{
    name,
    scope,
    config,
    enabled: config.enabled !== false,
    exposure: typeof config.exposure === "string" ? config.exposure : "codemode",
    transport: describeTransport(config),
    }];
  });
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
  const errors: string[] = [];
  const validate = (await loadModules()).servers.validateMcpServerConfig;
  const { resources } = await resolveScopedResources(cwd ?? homedir(), agentDir);
  const builtins = BUILTIN_EXTENSION_NAMES.map((name) => {
    const resource = resources.find((r) => r.type === "extensions" && r.path === `${BUILTIN_EXTENSION_PREFIX}${name}`);
    return { name, enabled: resource?.enabled ?? true, globalEnabled: resource?.globalEnabled ?? true };
  });
  const globalServers = readServers(mcpConfigPath("global", null, agentDir), "global", errors, validate);
  let project: McpSettingsResponse["project"] = null;
  let projectServers: McpServerView[] = [];
  if (cwd) {
    const path = mcpConfigPath("project", cwd, agentDir);
    const trust = getProjectTrustStatus(cwd, agentDir);
    project = { path, trusted: trust.trusted, ignored: !trust.trusted && existsSync(path) };
    // Like pi, an untrusted project's mcp.json is not read at all.
    if (trust.trusted) projectServers = readServers(path, "project", errors, validate);
  }
  // Project entries replace global entries with the same name (pi's precedence).
  const projectNames = new Set(projectServers.map((server) => server.name));
  const servers = [
    ...globalServers.map((server) => projectNames.has(server.name) ? { ...server, overridden: true } : server),
    ...projectServers,
  ];
  return {
    builtins,
    globalPath: mcpConfigPath("global", null, agentDir),
    project,
    servers,
    errors,
    logTail: readLogTail(join(agentDir, "mcp.log")),
  };
}

/** Project `mcp.json` runs commands, so it is only written where the project is trusted or needs no trust yet. */
function assertWritable(scope: McpScope, cwd: string | null, agentDir: string): void {
  if (scope !== "project") return;
  if (!cwd) throw new Error("cwd required for project MCP servers");
  const status = getProjectTrustStatus(cwd, agentDir);
  if (status.requiresTrust && !status.trusted) {
    throw new ProjectNotTrustedError("Trust this project before changing its MCP servers");
  }
}


export async function saveMcpServer(
  input: { cwd: string | null; scope: McpScope; name: string; config: unknown; previousName?: string },
  agentDir = getAgentDir(),
): Promise<void> {
  const { cwd, scope, name, config, previousName } = input;
  assertWritable(scope, cwd, agentDir);
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

export async function updateMcpServer(
  input: { cwd: string | null; scope: McpScope; name: string; enabled?: boolean; exposure?: McpExposure },
  agentDir = getAgentDir(),
): Promise<void> {
  assertWritable(input.scope, input.cwd, agentDir);
  const { config } = await loadModules();
  config.updateMcpServerConfig(mcpConfigPath(input.scope, input.cwd, agentDir), input.name, {
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.exposure !== undefined ? { exposure: input.exposure } : {}),
  });
}

export async function removeMcpServer(
  input: { cwd: string | null; scope: McpScope; name: string },
  agentDir = getAgentDir(),
): Promise<void> {
  assertWritable(input.scope, input.cwd, agentDir);
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
