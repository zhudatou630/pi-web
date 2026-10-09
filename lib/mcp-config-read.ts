import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, type McpServerConfig, type McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { isPathWithinRoots } from "./path-security";
import { assertSafeMcpValues, type McpValueParsers } from "./mcp-transport";

export class McpConfigError extends Error {}
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_CONFIG_BYTES = 1024 * 1024;

/** Follow user-global links; project links (including .pi) must stay in the project. */
export function resolveMcpConfigPath(path: string, projectRoot?: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  let links = 0;
  for (;;) {
    try {
      lstatSync(current); // A dangling link is not a missing config.
      current = realpathSync(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // lstat succeeds on a dangling link, realpath does not.
      try {
        if (lstatSync(current).isSymbolicLink()) {
          if (projectRoot) throw new McpConfigError("Dangling MCP config link");
          if (++links > 40) throw new McpConfigError("Too many MCP config links");
          current = resolve(dirname(current), readlinkSync(current));
          continue;
        }
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
      }
      const parent = dirname(current);
      if (parent === current) throw new McpConfigError("Cannot resolve MCP config path");
      missing.unshift(basename(current));
      current = parent;
    }
  }
  const target = join(current, ...missing);
  if (projectRoot && !isPathWithinRoots(target, new Set([realpathSync(projectRoot)]))) {
    throw new McpConfigError("Project MCP config resolves outside the project");
  }
  return target;
}

/** Open once, never block on a FIFO, and never include JSON source in an error. */
export function readMcpConfigFile(path: string, projectRoot?: string): {
  path: string; document: Record<string, unknown>; text?: string; mode?: number;
} {
  const target = resolveMcpConfigPath(path, projectRoot);
  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: target, document: {} };
    throw new McpConfigError(`Cannot open MCP config (${(error as NodeJS.ErrnoException).code ?? "I/O error"})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new McpConfigError("MCP config must be a regular file");
    if (stat.size > MAX_CONFIG_BYTES) throw new McpConfigError("MCP config exceeds 1 MiB");
    // Bound the read too, in case a writer grows the file after fstat.
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_CONFIG_BYTES) throw new McpConfigError("MCP config exceeds 1 MiB");
    const text = buffer.subarray(0, length).toString("utf8");
    let document: unknown;
    try { document = JSON.parse(text); } catch { throw new McpConfigError("Cannot parse MCP config: invalid JSON"); }
    if (!isRecord(document) || (document.mcpServers !== undefined && !isRecord(document.mcpServers))) {
      throw new McpConfigError('MCP config must be an object with an "mcpServers" object');
    }
    if (projectRoot && Object.keys(document.mcpServers ?? {}).length > 200) {
      throw new McpConfigError("Project MCP config exceeds 200 servers");
    }
    return { path: target, document, text, mode: stat.mode & 0o777 };
  } finally { closeSync(fd); }
}

export type McpEntry = Parameters<McpTransportFactory>[0];
export interface McpConfigValidator {
  validateMcpServerConfig(name: string, value: unknown): McpServerConfig | string;
  mcpNamespace(name: string): string;
}

/** SDK 1.0.4 precedence/override rules, with our bounded reader instead of its readFileSync. */
export function loadSafeMcpConfig(options: {
  agentDir: string; cwd: string; projectTrusted: boolean;
}, sdk: McpConfigValidator, parsers?: McpValueParsers) {
  const servers = new Map<string, McpEntry>();
  const errors: string[] = [];
  let autoEnableCodemode: boolean | undefined;
  const projectConfig = options.projectTrusted ? join(options.cwd, CONFIG_DIR_NAME, "mcp.json") : undefined;
  for (const [path, scope] of [
    [join(options.agentDir, "mcp.json"), "global"],
    ...(projectConfig ? [[projectConfig, "project"]] : []),
  ] as [string, "global" | "project"][]) {
    let document: Record<string, unknown>;
    try { document = readMcpConfigFile(path, scope === "project" ? options.cwd : undefined).document; }
    catch (error) {
      errors.push(`${path}: ${error instanceof McpConfigError ? error.message : "Cannot read MCP config"}`);
      continue;
    }
    if (typeof document.autoEnableCodemode === "boolean") autoEnableCodemode = document.autoEnableCodemode;
    else if (document.autoEnableCodemode !== undefined) errors.push(`${path}: autoEnableCodemode must be a boolean`);
    for (const [name, value] of Object.entries(document.mcpServers ?? {})) {
      const base = servers.get(name);
      const override = scope === "project" && isRecord(value) && value.command === undefined && value.url === undefined && value.type === undefined;
      if (override && (!base || Object.keys(value).some((key) => !["enabled", "exposure", "toolExposure"].includes(key)))) {
        errors.push(`${path}: server "${name}": override needs a global server and only enabled/exposure/toolExposure`);
        continue;
      }
      const config = sdk.validateMcpServerConfig(name, override ? { ...base!.config, ...value } : value);
      if (typeof config === "string") { errors.push(`${path}: ${config}`); continue; }
      // Session load must also refuse these before OAuth's direct sign-in path can resolve them.
      if (parsers) {
        try { assertSafeMcpValues(config, parsers); }
        catch { errors.push(`${path}: server "${name}" references PI_WEB_PASSWORD`); continue; }
      }
      const clash = [...servers.keys()].find((other) => other !== name && sdk.mcpNamespace(other) === sdk.mcpNamespace(name));
      if (clash) { errors.push(`${path}: server "${name}" conflicts with "${clash}"`); continue; }
      if (!override && scope === "project" && "url" in config && config.auth) {
        errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
        continue;
      }
      servers.set(name, override ? { ...base!, config, override: path } : { name, config, source: path, scope });
    }
  }
  return {
    servers: [...servers.values()], errors,
    ...(autoEnableCodemode === undefined ? {} : { autoEnableCodemode }),
    ...(projectConfig ? { projectConfig } : {}),
  };
}
