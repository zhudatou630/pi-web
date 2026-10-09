import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isRecord, McpConfigError, readMcpConfigFile, resolveMcpConfigPath } from "./mcp-config-read";

type Edit = (servers: Record<string, unknown>) => void;

function preparePath(path: string, projectRoot?: string): string {
  const target = resolveMcpConfigPath(path, projectRoot);
  mkdirSync(dirname(target), { recursive: true, mode: projectRoot ? 0o755 : 0o700 });
  return resolveMcpConfigPath(path, projectRoot);
}

function editLocked(path: string, target: string, edit: Edit, projectRoot?: string): void {
  const file = readMcpConfigFile(path, projectRoot);
  if (file.path !== target) throw new McpConfigError("MCP config path changed while waiting for its lock");
  const servers = isRecord(file.document.mcpServers) ? file.document.mcpServers : {};
  const before = JSON.stringify(file.document);
  edit(servers);
  Object.defineProperty(file.document, "mcpServers", { value: servers, enumerable: true, configurable: true, writable: true });
  if (before === JSON.stringify(file.document)) return;
  // Resolve again under the lock; a changed project link must never redirect the write.
  if (resolveMcpConfigPath(path, projectRoot) !== file.path) throw new McpConfigError("MCP config path changed while saving");
  const indent = (file.text && /^([ \t]+)\S/m.exec(file.text)?.[1]) || "  ";
  writePrivateFileAtomicSync(file.path, `${JSON.stringify(file.document, null, indent)}\n`, file.mode ?? (projectRoot ? 0o644 : 0o600));
}

/** All Settings edits are one locked read-modify-atomic-replace, including renames. */
export async function editMcpConfigFile(path: string, edit: Edit, projectRoot?: string): Promise<void> {
  const target = preparePath(path, projectRoot);
  let compromised = false;
  const release = await lockfile.lock(target, {
    realpath: false,
    retries: { retries: 30, factor: 1, minTimeout: 100, maxTimeout: 100 },
    onCompromised: () => { compromised = true; console.error("[pi-web] MCP config lock compromised"); },
  });
  try {
    if (compromised) throw new McpConfigError("MCP config lock compromised");
    editLocked(path, target, edit, projectRoot);
  } finally { await release().catch(() => undefined); }
}

/** SDK updateConfig is synchronous: refuse a busy lock rather than write without it. */
export function editMcpConfigFileSync(path: string, edit: Edit, projectRoot?: string): void {
  const target = preparePath(path, projectRoot);
  const release = lockfile.lockSync(target, { realpath: false, onCompromised: () => { console.error("[pi-web] MCP config lock compromised"); } });
  try { editLocked(path, target, edit, projectRoot); } finally { release(); }
}

export function patchMcpServer(servers: Record<string, unknown>, name: string, patch: {
  enabled?: boolean; exposure?: string;
}, override = false): void {
  if (!Object.hasOwn(servers, name)) {
    if (!override) throw new McpConfigError(`No MCP server named "${name}"`);
    Object.defineProperty(servers, name, { value: {}, enumerable: true, configurable: true, writable: true });
  }
  const server = servers[name];
  if (!isRecord(server)) throw new McpConfigError("MCP server entry must be an object");
  const keepDefaults = server.command === undefined && server.url === undefined && server.type === undefined;
  if (patch.enabled !== undefined) {
    if (patch.enabled && !keepDefaults) delete server.enabled;
    else server.enabled = patch.enabled;
  }
  if (patch.exposure !== undefined) {
    if (patch.exposure === "codemode" && !keepDefaults) delete server.exposure;
    else server.exposure = patch.exposure;
  }
}
