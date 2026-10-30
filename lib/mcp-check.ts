import { join } from "node:path";
import { type McpTransportFactory } from "@earendil-works/pi-coding-agent";
import type { McpCheckResponse, McpToolView } from "./api-types";
import { importSdkFile, loadSafeMcpTransport } from "./builtin-extensions";
import { createProjectCommandBashOperations } from "./project-command-env";
import { assertSafeMcpValues, resolvedMcpValues, type McpValueParsers } from "./mcp-transport";
import type { McpEntry } from "./mcp-config-read";

type Transport = ReturnType<McpTransportFactory>;
interface Connection {
  state: string; error?: string; hasResources: boolean; instructions?: string;
  tools: { name: string; description?: unknown; annotations?: unknown }[];
  getClient(): Promise<unknown>; close(): Promise<void>;
}
interface Runtime {
  McpServerConnection: new (options: {
    entry: McpEntry; cwd: string; credentials: unknown; createTransport: McpTransportFactory; onTools: () => void;
    providerToken?: (provider: string) => Promise<string | undefined>; log?: unknown;
  }) => Connection;
  McpOAuthCredentialStore: new (backend: unknown, lockDir: string) => unknown;
  McpServerLog: new (path: string) => unknown;
}
type ToolExposure = (config: McpEntry["config"], tool: string) => string;

const firstLine = (value: unknown) => typeof value === "string" ? value.trim().split("\n", 1)[0]!.slice(0, 300) : undefined;

/** Tool facts with server-supplied fields type-checked: MCP validates names and schemas only. */
function toolView(tool: Connection["tools"][number], entry: McpEntry, exposureOf: ToolExposure): McpToolView {
  const hints = typeof tool.annotations === "object" && tool.annotations !== null ? tool.annotations as Record<string, unknown> : {};
  const description = firstLine(tool.description);
  return {
    name: tool.name,
    ...(description ? { description } : {}),
    exposure: exposureOf(entry.config, tool.name),
    ...(hints.readOnlyHint === true ? { readOnly: true } : {}),
    ...(hints.destructiveHint === true ? { destructive: true } : {}),
  };
}

async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** SDK !command resolution is synchronous. Pre-resolve asynchronously so a timer can stop it. */
export async function prepareEntry(entry: McpEntry, parsers: McpValueParsers, cwd: string, agentDir: string, signal: AbortSignal): Promise<McpEntry> {
  assertSafeMcpValues(entry.config, parsers);
  const config = structuredClone(entry.config);
  const operations = createProjectCommandBashOperations({ agentBinDir: join(agentDir, "bin") });
  for (const { container, name, value } of resolvedMcpValues(config)) {
    // The SDK resolves oauth.clientSecret only when a refresh or sign-in needs it.
    if (container === "oauth" || !parsers.isCommandConfigValue(value)) continue;
    signal.throwIfAborted();
    const controller = new AbortController();
    const chunks: Buffer[] = [];
    let size = 0;
    // BashOperations combines stderr; SDK config commands deliberately ignore it.
    const result = await operations.exec(`(\n${value.slice(1)}\n) 2>/dev/null`, cwd, {
      signal: AbortSignal.any([signal, controller.signal]), timeout: 10,
      onData: (data) => {
        size += data.length;
        if (size > 64 * 1024) controller.abort();
        else chunks.push(Buffer.from(data));
      },
    });
    const resolved = Buffer.concat(chunks).toString("utf8").trim();
    if (size > 64 * 1024 || result.exitCode !== 0 || !resolved) throw new Error("MCP config command failed or exceeded 64 KiB");
    // SDK parses the prepared literal again; escape both interpolation and a leading !.
    const literal = resolved.replaceAll("$", () => "$$").replace(/^!/, "$!");
    ((config as unknown as Record<string, Record<string, unknown>>)[container])[name] = literal;
  }
  return { ...entry, config: { ...config, timeout: Math.min(config.timeout ?? 60, 15) } };
}

/**
 * One overall 20 s deadline; cleanup never waits more than another 2 s. `providerToken` serves
 * servers with `auth.provider`, like a session's model registry does.
 */
export async function checkSafeMcpServers(
  loaded: Promise<{ servers: McpEntry[]; errors: string[] }>, cwd: string, agentDir: string,
  providerToken?: (provider: string) => Promise<string | undefined>,
): Promise<McpCheckResponse> {
  const controller = new AbortController();
  const connections: Connection[] = [];
  const transports = new Set<Transport>();
  const deadline = setTimeout(() => controller.abort(new Error("MCP check exceeded 20 seconds")), 20_000);
  const closeTransports = () => {
    for (const transport of transports) void Promise.resolve().then(() => transport.close()).catch(() => undefined);
  };
  controller.signal.addEventListener("abort", closeTransports, { once: true });
  const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
  try {
    const work = async () => {
      const [runtime, auth, parsers, sdkServers, factory, config] = await Promise.all([
        importSdkFile<Runtime>("extensions/mcp/runtime.js"),
        importSdkFile<{ FileAuthStorageBackend: new (path: string) => unknown }>("core/auth-storage.js"),
        importSdkFile<McpValueParsers>("core/resolve-config-value.js"),
        importSdkFile<{ getMcpToolExposure: ToolExposure }>("core/mcp-servers.js"), loadSafeMcpTransport(), loaded,
      ]);
      controller.signal.throwIfAborted();
      const credentials = new runtime.McpOAuthCredentialStore(new auth.FileAuthStorageBackend(join(agentDir, "mcp-auth.json")), agentDir);
      // Server log notifications go to mcp.log, as with `pi mcp list`.
      const log = new runtime.McpServerLog(join(agentDir, "mcp.log"));
      const createTransport: McpTransportFactory = (entry, directory, provider) => {
        controller.signal.throwIfAborted();
        const transport = factory(entry, directory, provider);
        transports.add(transport);
        return transport;
      };
      const servers = await Promise.all(config.servers.map(async (entry) => {
        const report: McpCheckResponse["servers"][number] = {
          name: entry.name, scope: entry.scope === "project" ? "project" : "global",
          enabled: entry.config.enabled !== false, state: "disabled", tools: [],
        };
        if (!report.enabled) return report;
        let connection: Connection | undefined;
        try {
          const prepared = await prepareEntry(entry, parsers, cwd, agentDir, controller.signal);
          controller.signal.throwIfAborted();
          connection = new runtime.McpServerConnection({ entry: prepared, cwd, credentials, createTransport, providerToken, log, onTools: () => {} });
          connections.push(connection);
          await connection.getClient();
        } catch (error) {
          report.error = connection?.error ?? (error instanceof Error ? error.message : "MCP check failed");
        }
        report.state = connection?.state ?? "failed";
        report.tools = connection?.tools.filter((tool) => typeof tool.name === "string")
          .map((tool) => toolView(tool, entry, sdkServers.getMcpToolExposure)) ?? [];
        if (connection?.hasResources) report.resources = true;
        const instructions = connection?.instructions?.trim().split(/\n\s*\n/, 1)[0]?.slice(0, 1000);
        if (instructions) report.instructions = instructions;
        return report;
      }));
      return { servers, errors: config.errors };
    };
    return await Promise.race([work(), aborted]);
  } finally {
    clearTimeout(deadline);
    controller.abort(); // Also stops commands and prevents a late transport from being started.
    closeTransports();
    await within(Promise.all(connections.map((connection) => Promise.resolve().then(() => connection.close()).catch(() => undefined))), 2_000, "MCP close timed out").catch(() => undefined);
  }
}
