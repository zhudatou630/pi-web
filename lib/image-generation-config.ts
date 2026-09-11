import { readFileSync } from "node:fs";
import path from "node:path";
import { IMAGE_RUNTIME_PROVIDER, type ImageCapabilities, type ImageConfigView, type ImageConnectionView } from "./image-generation";

export const IMAGE_CONFIG_FILE = "images.json";

export type ImageConnection = ImageConnectionView;

export interface ImageConfig {
  defaultConnection: string;
  connections: Record<string, ImageConnection>;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : text(value, name);
}

function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty string array`);
  const values = value.map((item, index) => text(item, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicates`);
  return values;
}

function knownKeys(value: Record<string, unknown>, allowed: string[], name: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${name}.${unknown} is not supported`);
}

function readCapabilities(value: unknown, name: string): ImageCapabilities {
  if (value === undefined) return {};
  const values = record(value, name);
  knownKeys(values, ["editing", "sizes", "resolutions", "qualities"], name);
  if (values.editing !== undefined && typeof values.editing !== "boolean") throw new Error(`${name}.editing must be a boolean`);
  return {
    ...(values.editing === undefined ? {} : { editing: values.editing }),
    ...(values.sizes === undefined ? {} : { sizes: stringList(values.sizes, `${name}.sizes`) }),
    ...(values.resolutions === undefined ? {} : { resolutions: stringList(values.resolutions, `${name}.resolutions`) }),
    ...(values.qualities === undefined ? {} : { qualities: stringList(values.qualities, `${name}.qualities`) }),
  };
}

function readConnection(id: string, value: unknown): ImageConnection {
  const name = `${IMAGE_CONFIG_FILE}.connections.${id}`;
  const values = record(value, name);
  knownKeys(values, ["label", "provider", "model", "capabilities", "defaults"], name);
  const capabilities = readCapabilities(values.capabilities, `${name}.capabilities`);
  let defaults: ImageConnection["defaults"];
  if (values.defaults !== undefined) {
    const configured = record(values.defaults, `${name}.defaults`);
    knownKeys(configured, ["size", "resolution", "quality"], `${name}.defaults`);
    defaults = {
      ...(configured.size === undefined ? {} : { size: text(configured.size, `${name}.defaults.size`) }),
      ...(configured.resolution === undefined ? {} : { resolution: text(configured.resolution, `${name}.defaults.resolution`) }),
      ...(configured.quality === undefined ? {} : { quality: text(configured.quality, `${name}.defaults.quality`) }),
    };
    if (defaults.size && !capabilities.sizes?.includes(defaults.size)) throw new Error(`${name}.defaults.size is not declared in capabilities.sizes`);
    if (defaults.resolution && !capabilities.resolutions?.includes(defaults.resolution)) throw new Error(`${name}.defaults.resolution is not declared in capabilities.resolutions`);
    if (defaults.quality && !capabilities.qualities?.includes(defaults.quality)) throw new Error(`${name}.defaults.quality is not declared in capabilities.qualities`);
  }
  return {
    id,
    label: optionalText(values.label, `${name}.label`) ?? id,
    provider: text(values.provider, `${name}.provider`),
    model: text(values.model, `${name}.model`),
    capabilities,
    ...(defaults && Object.keys(defaults).length ? { defaults } : {}),
  };
}

export function readImageConfig(agentDir: string): ImageConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.join(agentDir, IMAGE_CONFIG_FILE), "utf8"));
  } catch {
    throw new Error(`Invalid ${IMAGE_CONFIG_FILE}`);
  }
  const values = record(parsed, IMAGE_CONFIG_FILE);
  knownKeys(values, ["default", "connections"], IMAGE_CONFIG_FILE);
  const configured = record(values.connections, `${IMAGE_CONFIG_FILE}.connections`);
  const entries = Object.entries(configured);
  if (!entries.length) throw new Error(`${IMAGE_CONFIG_FILE}.connections must not be empty`);
  const connections = Object.fromEntries(entries.map(([id, connection]) => [id, readConnection(id, connection)]));
  const selected = optionalText(values.default, `${IMAGE_CONFIG_FILE}.default`) ?? (entries.length === 1 ? entries[0][0] : undefined);
  if (!selected) throw new Error(`${IMAGE_CONFIG_FILE}.default is required with multiple connections`);
  if (!connections[selected]) throw new Error(`${IMAGE_CONFIG_FILE}.default references an unknown connection`);
  return { defaultConnection: selected, connections };
}

export function imageConfigView(config: ImageConfig): ImageConfigView {
  const connections = Object.values(config.connections).filter((connection) => connection.provider === IMAGE_RUNTIME_PROVIDER);
  const defaultConnection = connections.some((connection) => connection.id === config.defaultConnection)
    ? config.defaultConnection
    : connections[0]?.id ?? config.defaultConnection;
  return { defaultConnection, connections };
}