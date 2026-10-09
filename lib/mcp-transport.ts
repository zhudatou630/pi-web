import type { McpTransportFactory } from "@earendil-works/pi-coding-agent";

export interface McpValueParsers {
  getConfigValueEnvVarNames(value: string): string[];
  isCommandConfigValue(value: string): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Exactly the fields resolved by SDK 1.0.4, selected by the transport's url-presence rule. */
export function resolvedMcpValues(config: unknown): { container: "env" | "headers" | "oauth"; name: string; value: string }[] {
  if (!isRecord(config)) return [];
  const container = "url" in config ? "headers" : "env";
  const fields = isRecord(config[container]) ? Object.entries(config[container]) : [];
  const values: ReturnType<typeof resolvedMcpValues> = fields.filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => ({ container, name, value }));
  if (container === "headers" && isRecord(config.oauth) && typeof config.oauth.clientSecret === "string") {
    values.push({ container: "oauth", name: "clientSecret", value: config.oauth.clientSecret });
  }
  return values;
}

export function assertSafeMcpValues(config: unknown, parsers: McpValueParsers): void {
  // ponytail: reference guard, not a shell sandbox; isolate trusted commands at the OS boundary if needed.
  for (const { value } of resolvedMcpValues(config)) {
    const references = parsers.isCommandConfigValue(value)
      ? value.toUpperCase().includes("PI_WEB_PASSWORD")
      : parsers.getConfigValueEnvVarNames(value).some((name) => name.toUpperCase() === "PI_WEB_PASSWORD");
    if (references) throw new Error("MCP config references PI_WEB_PASSWORD; Pi Web refuses to resolve it");
  }
}

/** Validate before the default factory can resolve env/headers or execute a !command. */
export function safeMcpTransportFactory(factory: McpTransportFactory, parsers: McpValueParsers,
  scrub: (transport: ReturnType<McpTransportFactory>) => ReturnType<McpTransportFactory>): McpTransportFactory {
  return (entry, cwd, authProvider) => {
    assertSafeMcpValues(entry.config, parsers);
    return scrub(factory(entry, cwd, authProvider));
  };
}
