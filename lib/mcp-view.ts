/**
 * What Settings › MCP may show of an `mcp.json` entry: env/header/client-secret names and value
 * kinds, never values, and connection text with secret-looking parts masked. The raw entry only
 * leaves the server through an explicit "Edit JSON" request.
 */
import type { McpConfigValue, McpServerFacts } from "./api-types";
import type { McpValueParsers } from "./mcp-transport";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const MASK = "•••";
const SECRET_FLAG = /^--?[\w-]*(?:key|token|secret|password|passwd|auth)[\w-]*$/i;

/** Origin and path only: userinfo, query, and fragment often carry credentials. */
export function redactUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return value; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return value;
  return `${url.origin}${url.pathname}${url.search ? `?${MASK}` : ""}`;
}

/** Argument values after key/token/secret/password-like flags, and URLs, masked. */
export function redactArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    if (index > 0 && SECRET_FLAG.test(args[index - 1]!) && !arg.startsWith("-")) return MASK;
    const [, flag, value] = /^(--?[\w-]+)=(.*)$/.exec(arg) ?? [];
    if (flag && SECRET_FLAG.test(flag)) return `${flag}=${MASK}`;
    if (flag && /^https?:\/\//i.test(value!)) return `${flag}=${redactUrl(value!)}`;
    return /^https?:\/\//i.test(arg) ? redactUrl(arg) : arg;
  });
}

function describeValues(values: unknown, parsers: McpValueParsers): McpConfigValue[] {
  if (!isRecord(values)) return [];
  return Object.entries(values).map(([name, value]): McpConfigValue => {
    if (typeof value !== "string") return { name, kind: "literal" };
    // The command text is a value too (`!printf 'Bearer …'`); Edit JSON shows it.
    if (parsers.isCommandConfigValue(value)) return { name, kind: "command" };
    const vars = parsers.getConfigValueEnvVarNames(value);
    return vars.length > 0 ? { name, kind: "env", detail: vars.join(", ") } : { name, kind: "literal" };
  });
}

/**
 * A tool's exposure under `rules` (`toolExposure`): its exact entry, else the first matching `*`
 * pattern, else the server's. The SDK's `getMcpToolExposure`, with an own-property lookup.
 */
export function toolExposureOf(rules: Record<string, string>, serverExposure: string, tool: string): string {
  if (Object.hasOwn(rules, tool)) return rules[tool]!;
  for (const [pattern, exposure] of Object.entries(rules)) {
    if (!pattern.includes("*")) continue;
    const source = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    if (new RegExp(`^${source}$`).test(tool)) return exposure;
  }
  return serverExposure;
}

/** One server's records in an `mcp.log` tail; continuation lines (indented) stay with their record. */
export function mcpLogRecords(tail: string, server: string): string {
  const records: string[] = [];
  let keep = false;
  for (const line of tail.split("\n")) {
    if (!/^\s/.test(line)) keep = line.includes(` [${server}] `);
    if (keep) records.push(line);
  }
  return records.join("\n");
}

/** The facts of one entry as written; `config` may be the merged entry of a project override. */
export function describeMcpServer(config: Record<string, unknown>, parsers: McpValueParsers): McpServerFacts {
  const http = typeof config.url === "string";
  const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === "string") : [];
  const oauth = isRecord(config.oauth) ? config.oauth : undefined;
  const auth = isRecord(config.auth) && typeof config.auth.provider === "string" ? config.auth.provider : undefined;
  const headers = describeValues(http ? config.headers : undefined, parsers);
  return {
    type: http ? "http" : "stdio",
    transport: http ? redactUrl(config.url as string) : [String(config.command ?? ""), ...redactArgs(args)].join(" ").trim(),
    ...(typeof config.description === "string" && config.description.trim() ? { description: config.description.trim() } : {}),
    ...(!http && typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
    ...(typeof config.timeout === "number" ? { timeout: config.timeout } : {}),
    env: describeValues(http ? undefined : config.env, parsers),
    headers,
    ...(oauth ? { oauth: Object.keys(oauth).filter((key) => key !== "clientSecret").sort() } : {}),
    ...(oauth && typeof oauth.clientSecret === "string" ? { clientSecret: describeValues({ clientSecret: oauth.clientSecret }, parsers)[0] } : {}),
    ...(auth ? { authProvider: auth } : {}),
    // The SDK's rule (`usesOAuth`, extensions/mcp/runtime.js): HTTP without auth.provider or an Authorization header.
    usesOAuth: http && !auth && !headers.some((header) => header.name.toLowerCase() === "authorization"),
    toolExposure: isRecord(config.toolExposure)
      ? Object.fromEntries(Object.entries(config.toolExposure).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {},
  };
}
