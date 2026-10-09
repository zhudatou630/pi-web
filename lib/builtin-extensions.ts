import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  getPackageDir,
  getAgentDir,
  type InlineExtension,
  type McpTransportFactory,
} from "@earendil-works/pi-coding-agent";
import { sanitizeProjectCommandEnvironment } from "./project-command-env";
import { safeMcpTransportFactory, type McpValueParsers } from "./mcp-transport";
import { loadSafeMcpConfig, type McpConfigValidator } from "./mcp-config-read";
import { editMcpConfigFileSync, patchMcpServer } from "./mcp-config-file";

/**
 * The CLI's built-in extensions that the SDK exports (`llama.cpp` is not). SDK sessions get
 * none of them by default. As `builtin: true` entries they are `builtin:<name>` resources:
 * `-builtin:<name>` in `extensions` and `--no-extensions` disable them, and `replaceable`
 * lets an installed extension that registers `/mcp` (pi-mcp-adapter) take over.
 */
export const BUILTIN_EXTENSION_NAMES = ["codemode", "tool-search", "mcp"] as const;

export const BUILTIN_EXTENSION_PREFIX = "builtin:";

/**
 * Load a module the SDK ships but does not export, by file path under its `dist`. Loaded at
 * runtime from the installed SDK, not bundled: the bundler cannot follow a computed path.
 */
export function importSdkFile<T>(file: string): Promise<T> {
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(join(getPackageDir(), "dist", file)).href);
}

type McpTransport = ReturnType<McpTransportFactory>;
type StdioOptions = { command: string; env?: Record<string, string>; inheritEnv?: boolean };

let defaultTransportPromise: Promise<McpTransportFactory | null> | undefined;

function loadDefaultTransport(): Promise<McpTransportFactory | null> {
  defaultTransportPromise ??= importSdkFile<{ createDefaultTransport: McpTransportFactory }>("extensions/mcp/runtime.js")
    .then((runtime) => runtime.createDefaultTransport, (error) => {
      console.error("[pi-web] MCP transport unavailable:", error instanceof Error ? error.message : error);
      return null;
    });
  return defaultTransportPromise;
}

/**
 * The SDK's stdio transport passes the whole server environment to MCP servers. Rebuild it with
 * the environment project bash commands get: no `PORT` (some servers switch to HTTP on it),
 * `NODE_ENV`, `NEXT_*`, or `PI_WEB_PASSWORD`. Exported for the test.
 */
export function withProjectEnvironment(transport: McpTransport, baseEnvironment: NodeJS.ProcessEnv = process.env): McpTransport {
  const options = (transport as { options?: StdioOptions }).options;
  if (typeof options?.command !== "string") return transport; // HTTP
  const environment = Object.fromEntries(
    Object.entries(sanitizeProjectCommandEnvironment(baseEnvironment))
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const Stdio = transport.constructor as new (options: StdioOptions) => McpTransport;
  return new Stdio({ ...options, inheritEnv: false, env: { ...environment, ...options.env } });
}

export async function loadSafeMcpTransport(): Promise<McpTransportFactory> {
  const [factory, parsers] = await Promise.all([
    loadDefaultTransport(),
    importSdkFile<McpValueParsers>("core/resolve-config-value.js"),
  ]);
  // Never fall back to the SDK's own factory: it would hand servers the whole environment.
  if (!factory) throw new Error("MCP transport unavailable in Pi Web; see the server log");
  return safeMcpTransportFactory(factory, parsers, withProjectEnvironment);
}

export async function createBuiltinExtensions(): Promise<InlineExtension[]> {
  const [createTransport, validator, parsers] = await Promise.all([
    loadSafeMcpTransport(), importSdkFile<McpConfigValidator>("core/mcp-servers.js"),
    importSdkFile<McpValueParsers>("core/resolve-config-value.js"),
  ]);
  return [
    { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
    { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
    // The OAuth page must open in the user's browser, not on the server: the URL is
    // shown through ui.notify and the redirect URL is pasted back through ui.input.
    {
      name: "mcp",
      factory: createMcpExtension({
        openUrl: () => {}, createTransport,
        loadConfig: (ctx) => loadSafeMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }, validator, parsers),
        updateConfig: (entry, patch) => {
          const path = entry.override ?? entry.source;
          const projectRoot = entry.override || entry.scope === "project" ? dirname(dirname(path)) : undefined;
          editMcpConfigFileSync(path, (servers) => patchMcpServer(servers, entry.name, patch), projectRoot);
        },
      }),
      replaceable: true,
      builtin: true,
    },
  ];
}
