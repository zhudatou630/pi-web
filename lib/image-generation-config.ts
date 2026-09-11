import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { type ImageCapabilities, type ImageConfigView, type ImageConnectionView } from "./image-generation";
import { readModelsConfig } from "./models-config-store";

export const IMAGE_CONFIG_FILE = "images.json";
export const DEFAULT_IMAGE_CONNECTION_ID = "grok-imagine";

const IMAGE_ASPECT_RATIOS = ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];

export type ImageConnection = ImageConnectionView;

export interface ImageConfig {
  enabled: boolean;
  defaultConnection: string;
  connections: Record<string, ImageConnection>;
}

export interface ImageSettingsSnapshot {
  enabled: boolean;
  defaultConnection: string;
  builtinEnabled: Record<string, boolean>;
  builtinLabels: Record<string, string>;
  custom: Record<string, ImageConnection>;
  customEnabled: Record<string, boolean>;
}

export interface ImageSettingConnectionView {
  id: string;
  label: string;
  provider: string;
  model: string;
  enabled: boolean;
  signedIn: boolean;
  kind: "builtin" | "custom";
}

export interface ImageSettingsView {
  enabled: boolean;
  defaultConnection: string;
  connections: ImageSettingConnectionView[];
}

export interface ImageSettingsPatch {
  enabled?: boolean;
  defaultConnection?: string;
  connections?: Record<string, { enabled: boolean }>;
}

export interface ImageSettingsWriteOptions {
  hasAuth?: (provider: string) => boolean;
}

export type ImageConfigErrorCode = "UNKNOWN_CONNECTION" | "PROVIDER_NOT_CONFIGURED";

export class ImageConfigError extends Error {
  constructor(readonly code: ImageConfigErrorCode, message: string) {
    super(message);
    this.name = "ImageConfigError";
  }
}

type StoredImageSettings = Record<string, unknown> & {
  version?: unknown;
  enabled?: unknown;
  default?: unknown;
  connections?: unknown;
  custom?: unknown;
};

export const BUILTIN_IMAGE_CONNECTIONS: readonly ImageConnection[] = [
  {
    id: "chatgpt-flare",
    label: "ChatGPT Flare",
    provider: "openai-codex",
    model: "gpt-image-2.5-flare",
    capabilities: { editing: true, sizes: IMAGE_ASPECT_RATIOS, qualities: ["low", "medium", "high"] },
    defaults: { size: "auto", quality: "medium" },
  },
  {
    id: "chatgpt-sunburst",
    label: "ChatGPT Sunburst",
    provider: "openai-codex",
    model: "gpt-image-2.5-sunburst",
    capabilities: { editing: true, sizes: IMAGE_ASPECT_RATIOS, qualities: ["low", "medium", "high"] },
    defaults: { size: "auto", quality: "medium" },
  },
  {
    id: "grok-imagine",
    label: "Grok Imagine",
    provider: "xai",
    model: "grok-imagine-image-2.0",
    capabilities: { editing: true, sizes: IMAGE_ASPECT_RATIOS, resolutions: ["1k", "2k"], qualities: ["low", "medium"] },
    defaults: { size: "auto", resolution: "1k", quality: "medium" },
  },
  {
    id: "banana-2",
    label: "Banana 2",
    provider: "antigravity",
    model: "gemini-3.1-flash-image",
    capabilities: { editing: true, sizes: IMAGE_ASPECT_RATIOS, resolutions: ["1k", "2k"] },
    defaults: { size: "auto", resolution: "1k" },
  },
];

const BUILTIN_IMAGE_CONNECTION_IDS = new Set(BUILTIN_IMAGE_CONNECTIONS.map((connection) => connection.id));

export function getImageSettingsPath(agentDir: string): string {
  return path.join(agentDir, "images", "settings.json");
}

export function getImageLegacyConfigPath(agentDir: string): string {
  return path.join(agentDir, IMAGE_CONFIG_FILE);
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

function readConnection(id: string, value: unknown, source: string, extraKeys: string[] = []): ImageConnection {
  const name = `${source}.${id}`;
  const values = record(value, name);
  knownKeys(values, ["label", "provider", "model", "capabilities", "defaults", ...extraKeys], name);
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

function copyBuiltin(connection: ImageConnection): ImageConnection {
  return {
    ...connection,
    capabilities: {
      ...connection.capabilities,
      ...(connection.capabilities.sizes ? { sizes: [...connection.capabilities.sizes] } : {}),
      ...(connection.capabilities.resolutions ? { resolutions: [...connection.capabilities.resolutions] } : {}),
      ...(connection.capabilities.qualities ? { qualities: [...connection.capabilities.qualities] } : {}),
    },
    ...(connection.defaults ? { defaults: { ...connection.defaults } } : {}),
  };
}

function emptyBuiltinEnabled(): Record<string, boolean> {
  return Object.fromEntries(BUILTIN_IMAGE_CONNECTIONS.map((connection) => [connection.id, false]));
}

function emptySnapshot(): ImageSettingsSnapshot {
  return {
    enabled: false,
    defaultConnection: DEFAULT_IMAGE_CONNECTION_ID,
    builtinEnabled: emptyBuiltinEnabled(),
    builtinLabels: {},
    custom: {},
    customEnabled: {},
  };
}

function connectionLabel(snapshot: ImageSettingsSnapshot, connection: ImageConnection): string {
  return snapshot.builtinLabels[connection.id] || connection.label;
}

function serializeConnection(connection: ImageConnection): Record<string, unknown> {
  return {
    label: connection.label,
    provider: connection.provider,
    model: connection.model,
    ...(Object.keys(connection.capabilities).length ? { capabilities: connection.capabilities } : {}),
    ...(connection.defaults && Object.keys(connection.defaults).length ? { defaults: connection.defaults } : {}),
  };
}

function liveConnectionIds(snapshot: ImageSettingsSnapshot): string[] {
  return [
    ...BUILTIN_IMAGE_CONNECTIONS.filter((connection) => snapshot.builtinEnabled[connection.id]).map((connection) => connection.id),
    ...Object.keys(snapshot.custom).filter((id) => !BUILTIN_IMAGE_CONNECTION_IDS.has(id) && snapshot.customEnabled[id] !== false),
  ];
}

function hasLiveConnection(snapshot: ImageSettingsSnapshot): boolean {
  return liveConnectionIds(snapshot).length > 0;
}

function resolveDefaultConnection(snapshot: ImageSettingsSnapshot, preferred?: string): string {
  const live = liveConnectionIds(snapshot);
  if (preferred && live.includes(preferred)) return preferred;
  if (live.includes(snapshot.defaultConnection)) return snapshot.defaultConnection;
  return live[0] ?? DEFAULT_IMAGE_CONNECTION_ID;
}

function readLegacyImageConfig(agentDir: string): { defaultConnection: string; connections: Record<string, ImageConnection> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getImageLegacyConfigPath(agentDir), "utf8"));
  } catch {
    throw new Error(`Invalid ${IMAGE_CONFIG_FILE}`);
  }
  const values = record(parsed, IMAGE_CONFIG_FILE);
  knownKeys(values, ["default", "connections"], IMAGE_CONFIG_FILE);
  const configured = record(values.connections, `${IMAGE_CONFIG_FILE}.connections`);
  const entries = Object.entries(configured);
  if (!entries.length) throw new Error(`${IMAGE_CONFIG_FILE}.connections must not be empty`);
  const connections = Object.fromEntries(entries.map(([id, connection]) => [id, readConnection(id, connection, `${IMAGE_CONFIG_FILE}.connections`)]));
  const selected = optionalText(values.default, `${IMAGE_CONFIG_FILE}.default`) ?? (entries.length === 1 ? entries[0][0] : undefined);
  if (!selected) throw new Error(`${IMAGE_CONFIG_FILE}.default is required with multiple connections`);
  if (!connections[selected]) throw new Error(`${IMAGE_CONFIG_FILE}.default references an unknown connection`);
  return { defaultConnection: selected, connections };
}

function snapshotFromLegacy(legacy: { defaultConnection: string; connections: Record<string, ImageConnection> }): ImageSettingsSnapshot {
  const builtinEnabled = emptyBuiltinEnabled();
  const custom: Record<string, ImageConnection> = {};
  const customEnabled: Record<string, boolean> = {};
  for (const [id, connection] of Object.entries(legacy.connections)) {
    if (BUILTIN_IMAGE_CONNECTION_IDS.has(id)) builtinEnabled[id] = true;
    else {
      custom[id] = connection;
      customEnabled[id] = true;
    }
  }
  const snapshot: ImageSettingsSnapshot = {
    enabled: true,
    defaultConnection: DEFAULT_IMAGE_CONNECTION_ID,
    builtinEnabled,
    builtinLabels: {},
    custom,
    customEnabled,
  };
  snapshot.defaultConnection = resolveDefaultConnection(snapshot, legacy.defaultConnection);
  return snapshot;
}

function readStoredSettings(settingsPath: string): StoredImageSettings {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid image settings: expected an object");
  }
  return parsed as StoredImageSettings;
}

function snapshotFromSettings(stored: StoredImageSettings): ImageSettingsSnapshot {
  const builtinEnabled = emptyBuiltinEnabled();
  const builtinLabels: Record<string, string> = {};
  if (stored.connections !== undefined) {
    const configured = record(stored.connections, "images/settings.json.connections");
    for (const connection of BUILTIN_IMAGE_CONNECTIONS) {
      const value = configured[connection.id];
      builtinEnabled[connection.id] = Boolean(
        value
        && typeof value === "object"
        && !Array.isArray(value)
        && (value as { enabled?: unknown }).enabled === true,
      );
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const label = optionalText((value as { label?: unknown }).label, `images/settings.json.connections.${connection.id}.label`);
        if (label) builtinLabels[connection.id] = label;
      }
    }
  }
  const custom: Record<string, ImageConnection> = {};
  const customEnabled: Record<string, boolean> = {};
  if (stored.custom !== undefined) {
    const configured = record(stored.custom, "images/settings.json.custom");
    for (const [id, value] of Object.entries(configured)) {
      if (BUILTIN_IMAGE_CONNECTION_IDS.has(id)) continue;
      const raw = record(value, `images/settings.json.custom.${id}`);
      custom[id] = readConnection(id, value, "images/settings.json.custom", ["enabled"]);
      customEnabled[id] = raw.enabled !== false;
    }
  }
  const snapshot: ImageSettingsSnapshot = {
    enabled: stored.enabled === true,
    defaultConnection: DEFAULT_IMAGE_CONNECTION_ID,
    builtinEnabled,
    builtinLabels,
    custom,
    customEnabled,
  };
  snapshot.defaultConnection = resolveDefaultConnection(
    snapshot,
    optionalText(stored.default, "images/settings.json.default"),
  );
  return snapshot;
}

export function loadImageSettingsSnapshot(agentDir: string): ImageSettingsSnapshot {
  const settingsPath = getImageSettingsPath(agentDir);
  if (existsSync(settingsPath)) return snapshotFromSettings(readStoredSettings(settingsPath));
  if (existsSync(getImageLegacyConfigPath(agentDir))) return snapshotFromLegacy(readLegacyImageConfig(agentDir));
  return emptySnapshot();
}

export function isImageGenerationEnabled(agentDir: string): boolean {
  const settingsPath = getImageSettingsPath(agentDir);
  if (existsSync(settingsPath)) {
    try {
      return readStoredSettings(settingsPath).enabled === true;
    } catch {
      return false;
    }
  }
  return existsSync(getImageLegacyConfigPath(agentDir));
}

export function resolveImageConfig(agentDir: string): ImageConfig {
  const snapshot = loadImageSettingsSnapshot(agentDir);
  if (!snapshot.enabled) {
    return { enabled: false, defaultConnection: snapshot.defaultConnection, connections: {} };
  }
  const connections: Record<string, ImageConnection> = {};
  for (const connection of BUILTIN_IMAGE_CONNECTIONS) {
    if (snapshot.builtinEnabled[connection.id]) {
      connections[connection.id] = { ...copyBuiltin(connection), label: connectionLabel(snapshot, connection) };
    }
  }
  for (const [id, connection] of Object.entries(snapshot.custom)) {
    if (snapshot.customEnabled[id] === false || connections[id]) continue;
    connections[id] = connection;
  }
  return {
    enabled: true,
    defaultConnection: resolveDefaultConnection(snapshot),
    connections,
  };
}

export function imageConfigView(config: ImageConfig): ImageConfigView {
  const connections = Object.values(config.connections);
  const defaultConnection = connections.some((connection) => connection.id === config.defaultConnection)
    ? config.defaultConnection
    : connections[0]?.id ?? "";
  return { defaultConnection, connections };
}

export function imagePopupView(config: ImageConfig, hasAuth: (provider: string) => boolean): ImageConfigView {
  const view = imageConfigView(config);
  const connections = view.connections.filter((connection) => hasAuth(connection.provider));
  const defaultConnection = connections.some((connection) => connection.id === view.defaultConnection)
    ? view.defaultConnection
    : connections[0]?.id ?? "";
  return { defaultConnection, connections };
}

export function imageSettingsView(snapshot: ImageSettingsSnapshot, hasAuth: (provider: string) => boolean): ImageSettingsView {
  return {
    enabled: snapshot.enabled,
    defaultConnection: snapshot.defaultConnection,
    connections: [
      ...BUILTIN_IMAGE_CONNECTIONS.map((connection) => ({
        id: connection.id,
        label: connectionLabel(snapshot, connection),
        provider: connection.provider,
        model: connection.model,
        enabled: snapshot.builtinEnabled[connection.id] === true,
        signedIn: hasAuth(connection.provider),
        kind: "builtin" as const,
      })),
      ...Object.values(snapshot.custom).map((connection) => ({
        id: connection.id,
        label: connection.label,
        provider: connection.provider,
        model: connection.model,
        enabled: snapshot.customEnabled[connection.id] !== false,
        signedIn: hasAuth(connection.provider),
        kind: "custom" as const,
      })),
    ],
  };
}

function applySettingsPatch(
  snapshot: ImageSettingsSnapshot,
  patch: ImageSettingsPatch,
  options: ImageSettingsWriteOptions = {},
): ImageSettingsSnapshot {
  const next: ImageSettingsSnapshot = {
    enabled: patch.enabled ?? snapshot.enabled,
    defaultConnection: snapshot.defaultConnection,
    builtinEnabled: { ...snapshot.builtinEnabled },
    builtinLabels: { ...snapshot.builtinLabels },
    custom: snapshot.custom,
    customEnabled: { ...snapshot.customEnabled },
  };
  if (patch.connections) {
    for (const [id, value] of Object.entries(patch.connections)) {
      const builtin = BUILTIN_IMAGE_CONNECTIONS.find((connection) => connection.id === id);
      const currentEnabled = builtin
        ? snapshot.builtinEnabled[id] === true
        : Object.hasOwn(snapshot.custom, id) && snapshot.customEnabled[id] !== false;
      const provider = builtin?.provider ?? snapshot.custom[id]?.provider;
      if (!builtin && !Object.hasOwn(next.custom, id)) throw new ImageConfigError("UNKNOWN_CONNECTION", `Unknown image connection: ${id}`);
      if (value.enabled && !currentEnabled && options.hasAuth && provider && !options.hasAuth(provider)) {
        throw new ImageConfigError("PROVIDER_NOT_CONFIGURED", `Image connection ${id} cannot be enabled without configured credentials`);
      }
      if (builtin) next.builtinEnabled[id] = value.enabled;
      else next.customEnabled[id] = value.enabled;
    }
  }
  const shouldBootstrapBuiltins = patch.enabled === true
    && !snapshot.enabled
    && !hasLiveConnection(snapshot)
    && patch.connections === undefined;
  if (shouldBootstrapBuiltins) {
    for (const connection of BUILTIN_IMAGE_CONNECTIONS) {
      if (!options.hasAuth || options.hasAuth(connection.provider)) next.builtinEnabled[connection.id] = true;
    }
  }
  next.defaultConnection = resolveDefaultConnection(next, patch.defaultConnection ?? snapshot.defaultConnection);
  return next;
}

function persistImageSettings(agentDir: string, next: ImageSettingsSnapshot): ImageSettingsSnapshot {
  const settingsPath = getImageSettingsPath(agentDir);
  const stored = readStoredSettings(settingsPath);
  const payload: StoredImageSettings = {
    ...stored,
    version: 1,
    enabled: next.enabled,
    default: next.defaultConnection,
    connections: Object.fromEntries(
      BUILTIN_IMAGE_CONNECTIONS.map((connection) => [connection.id, {
        enabled: next.builtinEnabled[connection.id] === true,
        ...(next.builtinLabels[connection.id] ? { label: next.builtinLabels[connection.id] } : {}),
      }]),
    ),
  };
  const custom = Object.fromEntries(
    Object.entries(next.custom).map(([id, connection]) => [id, {
      enabled: next.customEnabled[id] !== false,
      ...serializeConnection(connection),
    }]),
  );
  if (Object.keys(custom).length) payload.custom = custom;
  else delete payload.custom;
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify(payload, null, 2));
  return next;
}

export function writeImageGenerationSettings(
  patch: ImageSettingsPatch,
  agentDir: string,
  options: ImageSettingsWriteOptions = {},
): ImageSettingsSnapshot {
  return persistImageSettings(agentDir, applySettingsPatch(loadImageSettingsSnapshot(agentDir), patch, options));
}

export function renameImageConnection(id: string, label: string, agentDir: string): ImageSettingsSnapshot {
  const name = text(label, "label");
  const snapshot = loadImageSettingsSnapshot(agentDir);
  const next: ImageSettingsSnapshot = {
    ...snapshot,
    builtinLabels: { ...snapshot.builtinLabels },
    custom: { ...snapshot.custom },
  };
  const builtin = BUILTIN_IMAGE_CONNECTIONS.find((connection) => connection.id === id);
  if (builtin) {
    if (name === builtin.label) delete next.builtinLabels[id];
    else next.builtinLabels[id] = name;
    return persistImageSettings(agentDir, next);
  }
  if (!Object.hasOwn(next.custom, id)) throw new ImageConfigError("UNKNOWN_CONNECTION", `Unknown image connection: ${id}`);
  next.custom[id] = { ...next.custom[id], label: name };
  return persistImageSettings(agentDir, next);
}

function customImageConnection(id: string, label: string, provider: string, model: string): ImageConnection {
  const template = BUILTIN_IMAGE_CONNECTIONS.find((connection) => connection.id === (model.startsWith("grok-imagine") ? "grok-imagine" : "chatgpt-flare"));
  if (!template) throw new Error("Missing built-in image template");
  return { ...copyBuiltin(template), id, label, provider, model };
}

function allocateImageConnectionId(label: string, snapshot: ImageSettingsSnapshot): string {
  const taken = new Set([...BUILTIN_IMAGE_CONNECTION_IDS, ...Object.keys(snapshot.custom)]);
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
  const id = BUILTIN_IMAGE_CONNECTION_IDS.has(base) ? `custom-${base}` : base;
  let suffix = 2;
  let candidate = id;
  while (taken.has(candidate)) candidate = `${id}-${suffix++}`;
  return candidate;
}

export function upsertImageCustomConnection(
  input: { id?: string; label: string; provider: string; model: string },
  agentDir: string,
): ImageSettingsSnapshot {
  const label = text(input.label, "label");
  const provider = text(input.provider, "provider");
  const model = text(input.model, "model");
  const snapshot = loadImageSettingsSnapshot(agentDir);
  const next: ImageSettingsSnapshot = {
    ...snapshot,
    custom: { ...snapshot.custom },
    customEnabled: { ...snapshot.customEnabled },
  };
  const requestedId = input.id?.trim();
  let id: string;
  if (requestedId) {
    if (BUILTIN_IMAGE_CONNECTION_IDS.has(requestedId) || !Object.hasOwn(next.custom, requestedId)) {
      throw new ImageConfigError("UNKNOWN_CONNECTION", `Unknown image connection: ${requestedId}`);
    }
    id = requestedId;
  } else {
    id = allocateImageConnectionId(label, next);
  }
  next.custom[id] = customImageConnection(id, label, provider, model);
  if (next.customEnabled[id] === undefined) next.customEnabled[id] = true;
  next.defaultConnection = resolveDefaultConnection(next, next.defaultConnection);
  return persistImageSettings(agentDir, next);
}

export function removeImageCustomConnection(id: string, agentDir: string): ImageSettingsSnapshot {
  const snapshot = loadImageSettingsSnapshot(agentDir);
  if (!Object.hasOwn(snapshot.custom, id)) throw new ImageConfigError("UNKNOWN_CONNECTION", `Unknown image connection: ${id}`);
  const custom = { ...snapshot.custom };
  const customEnabled = { ...snapshot.customEnabled };
  delete custom[id];
  delete customEnabled[id];
  const next: ImageSettingsSnapshot = { ...snapshot, custom, customEnabled };
  next.defaultConnection = resolveDefaultConnection(next);
  return persistImageSettings(agentDir, next);
}

export function isImageProviderConfigured(agentDir: string, provider: string): boolean {
  const configured = readModelsConfig(path.join(agentDir, "models.json")).providers;
  return Boolean(
    configured
    && typeof configured === "object"
    && !Array.isArray(configured)
    && Object.hasOwn(configured, provider),
  );
}

export function imageCustomProviderIds(agentDir: string, snapshot = loadImageSettingsSnapshot(agentDir)): string[] {
  const configured = readModelsConfig(path.join(agentDir, "models.json")).providers;
  const fromModels = configured && typeof configured === "object" && !Array.isArray(configured)
    ? Object.keys(configured as Record<string, unknown>)
    : [];
  const fromCustom = Object.values(snapshot.custom).map((connection) => connection.provider);
  return [...new Set([...fromModels, ...fromCustom].filter(Boolean))].sort();
}

export function imageSettingsApiResponse(
  agentDir: string,
  options: { hasAuth(provider: string): boolean; providerName(id: string): string },
) {
  const snapshot = loadImageSettingsSnapshot(agentDir);
  return {
    ...imageSettingsView(snapshot, options.hasAuth),
    providers: imageCustomProviderIds(agentDir, snapshot).map((id) => ({
      id,
      name: options.providerName(id),
      signedIn: options.hasAuth(id),
    })),
  };
}
